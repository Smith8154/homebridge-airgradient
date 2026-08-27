import axios from 'axios';
import {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  PlatformAccessory,
  PlatformConfig,
  Service,
  Logging,
  HAP,
  WithUUID,
} from 'homebridge';

type CharacteristicClass = WithUUID<{ new (): Characteristic }>;

let hap: HAP;

interface AirGradientData {
  locationId: number;
  pm01: number;
  pm02: number;
  pm02Compensated?: number | null;
  pm10: number;
  pm003Count: number;
  atmp: number;
  atmpCompensated?: number | null;
  rhum: number;
  rhumCompensated?: number | null;
  rco2: number;
  tvoc: number;
  wifi: number;
  timestamp: string;
  ledMode: string;
  ledCo2Threshold1: number;
  ledCo2Threshold2: number;
  ledCo2ThresholdEnd: number;
  serialno: string | number;
  model: string | number;
  firmwareVersion?: string | null;
  firmware?: string | null;
  // Only present on models that carry the corresponding sensor.
  tvocIndex?: number;
  noxIndex?: number;
}

interface SensorConfig {
  serialno: string;
  co2AlertThreshold?: number;
  pollingInterval?: number;
  useCompensatedValues?: boolean;
  offlineAfterFailures?: number;
}

const PLUGIN_NAME = 'homebridge-airgradient';
const PLATFORM_NAME = 'AirGradientPlatform';

// Consecutive failed polls before a sensor is reported as unavailable in HomeKit.
// At the default 60s interval that is roughly three minutes of silence, long enough
// to ride out a router reboot without flapping the accessory.
const DEFAULT_OFFLINE_AFTER_FAILURES = 3;


class AirGradientPlatform implements DynamicPlatformPlugin {
  public readonly log: Logging;
  public readonly api: API;
  public readonly fetchLogs: boolean;
  public readonly verboseLogs: boolean;

  // Keep a stable map of cached and newly-created accessories by UUID
  private readonly accessories = new Map<string, PlatformAccessory>();

  // Persist sensor configs to act on them after didFinishLaunching
  private readonly sensorConfigs: SensorConfig[] = [];

  constructor(log: Logging, config: PlatformConfig, api: API) {
    this.log = log;
    this.api = api;
    this.fetchLogs = config?.fetchLogs ?? true;
    this.verboseLogs = config?.verboseLogs ?? false;

    hap = api.hap;

    if (Array.isArray(config?.sensors)) {
      const seen = new Set<string>();

      for (const sensorConfig of config.sensors as SensorConfig[]) {
        if (!sensorConfig?.serialno) {
          continue;
        }

        // Hand-edited config.json can supply a bare number, which hap.uuid.generate rejects.
        const serialno = String(sensorConfig.serialno);

        // Two entries with one serial produce one UUID, so the second registration would
        // collide and both pollers would hit the same device. Keep the first entry.
        if (seen.has(serialno)) {
          this.log.warn(
            `Ignoring duplicate sensor entry for serial number ${serialno}. ` +
            'Each sensor must appear only once; the first entry\'s settings are used.',
          );
          continue;
        }

        seen.add(serialno);
        this.sensorConfigs.push({ ...sensorConfig, serialno });
        this.log.info('Queued sensor for init with serial number:', serialno);
      }
    }

    // Only manipulate accessories after Homebridge has finished launching, so cache restore happens first.
    this.api.on('didFinishLaunching', () => {
      this.log.info('Did finish launching');

      const configuredUuids = new Set<string>();

      for (const sensorConfig of this.sensorConfigs) {
        const uuid = hap.uuid.generate(sensorConfig.serialno);
        configuredUuids.add(uuid);
        const cached = this.accessories.get(uuid);

        if (cached) {
          this.log.info('Restoring existing accessory from cache:', cached.displayName);
          if (!cached.context.serial) {
            cached.context.serial = sensorConfig.serialno;
          }
          new AirGradientSensor(this, cached, sensorConfig);
        } else {
          this.log.info('Adding new accessory for serial number:', sensorConfig.serialno);
          const accessory = new this.api.platformAccessory(
            `AirGradient Sensor ${sensorConfig.serialno}`,
            uuid,
          );
          accessory.context.serial = sensorConfig.serialno;
          new AirGradientSensor(this, accessory, sensorConfig);
          this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);

          this.accessories.set(uuid, accessory);
        }
      }

      this.removeOrphanedAccessories(configuredUuids);
    });
  }

  // Drops cached accessories whose sensor is no longer in the config, which is the only
  // signal that the user actually wants them gone. A sensor that is merely offline still
  // has its config entry and is left alone -- unregistering it would throw away its room,
  // name, scenes and automations over what may be a temporary network outage.
  private removeOrphanedAccessories(configuredUuids: Set<string>) {
    const orphans: PlatformAccessory[] = [];

    for (const [uuid, accessory] of this.accessories) {
      if (!configuredUuids.has(uuid)) {
        orphans.push(accessory);
        this.accessories.delete(uuid);
      }
    }

    if (orphans.length === 0) {
      return;
    }

    for (const accessory of orphans) {
      this.log.info('Removing accessory no longer present in the config:', accessory.displayName);
    }

    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, orphans);
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.accessories.set(accessory.UUID, accessory);
  }
}

// AccessoryInformation characteristics are strings; the AirGradient payload types
// serialno/model as `string | number`, so coerce and drop blanks.
function toInfoString(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const text = String(value).trim();
  return text.length > 0 ? text : undefined;
}

// HAP ignores a Model or SerialNumber of 1 character or less and keeps the old value.
function toIdentityString(value: unknown): string | undefined {
  const text = toInfoString(value);
  return text && text.length > 1 ? text : undefined;
}

// The Home app only renders a dotted numeric firmware revision, so pull that out of
// whatever the device reports (e.g. "3.1.9-rc2" -> "3.1.9").
function toFirmwareRevision(value: unknown): string | undefined {
  const text = toInfoString(value);
  const match = text?.match(/\d+(?:\.\d+){0,2}/);
  return match ? match[0] : undefined;
}

// Different AirGradient firmware builds spell this key differently, so try each.
const FIRMWARE_KEYS = ['firmwareVersion', 'firmware', 'fwVersion', 'fwversion'];

function readFirmwareRevision(data: AirGradientData): string | undefined {
  const record = data as unknown as Record<string, unknown>;
  for (const key of FIRMWARE_KEYS) {
    const revision = toFirmwareRevision(record[key]);
    if (revision) {
      return revision;
    }
  }
  return undefined;
}

function isAirGradientData(x: unknown): x is AirGradientData {
  if (x === null || typeof x !== 'object') {
    return false;
  }
  const o = x as Record<string, unknown>;

  // Minimal required fields you actually rely on elsewhere
  return (
    typeof o.pm02 === 'number' &&
    typeof o.pm10 === 'number' &&
    typeof o.rco2 === 'number' &&
    typeof o.atmp === 'number' &&
    typeof o.rhum === 'number'
  );
}

class AirGradientSensor {
  private readonly accessory: PlatformAccessory;
  private readonly log: Logging;
  private readonly serialno: string;
  private readonly pollingInterval: number;
  private readonly apiUrl: string;
  private firmwareLookupWarned = false;
  private consecutiveFailures = 0;
  private offline = false;
  private readonly offlineAfterFailures: number;
  private readonly service: Service;
  private readonly serviceTemp: Service;
  private readonly serviceCO2: Service;
  private readonly serviceHumid: Service;
  private readonly useCompensatedValues: boolean;
  private readonly co2AlertThreshold: number;
  private readonly fetchLogs: boolean;
  private readonly verboseLogs: boolean;

  constructor(platform: AirGradientPlatform, accessory: PlatformAccessory, sensorConfig: SensorConfig) {
    this.accessory = accessory;
    this.log = platform.log;
    this.serialno = sensorConfig.serialno;

    this.pollingInterval = (sensorConfig.pollingInterval && sensorConfig.pollingInterval > 0)
      ? sensorConfig.pollingInterval
      : 60000; // Default to 1 minute, must be higher than 0

    this.useCompensatedValues = sensorConfig.useCompensatedValues ?? false;

    this.co2AlertThreshold = (sensorConfig.co2AlertThreshold && sensorConfig.co2AlertThreshold > 0)
      ? sensorConfig.co2AlertThreshold
      : 800;

    this.offlineAfterFailures = (sensorConfig.offlineAfterFailures && sensorConfig.offlineAfterFailures > 0)
      ? Math.floor(sensorConfig.offlineAfterFailures)
      : DEFAULT_OFFLINE_AFTER_FAILURES;

    this.fetchLogs = platform.fetchLogs;
    this.verboseLogs = platform.verboseLogs;

    // Construct the local API URL using the serialno
    this.apiUrl = `http://airgradient_${this.serialno}.local/measures/current`;

    // Apply whatever identity we already know. On a restart this comes from the cached
    // context, so HomeKit shows the real model and firmware before the first poll lands.
    this.applyAccessoryInformation();

    this.service = this.accessory.getService(hap.Service.AirQualitySensor) ||
      this.accessory.addService(hap.Service.AirQualitySensor);
    this.serviceTemp = this.accessory.getService(hap.Service.TemperatureSensor) ||
      this.accessory.addService(hap.Service.TemperatureSensor);
    this.serviceCO2 = this.accessory.getService(hap.Service.CarbonDioxideSensor) ||
      this.accessory.addService(hap.Service.CarbonDioxideSensor);
    this.serviceHumid = this.accessory.getService(hap.Service.HumiditySensor) ||
      this.accessory.addService(hap.Service.HumiditySensor);

    this.markReadingsUnavailable('AirGradient sensor has not reported a reading yet');

    this.updateData();
  }

  // Readings every model reports; isAirGradientData() guarantees each one's source field.
  private coreReadings(): Array<[Service, CharacteristicClass]> {
    const C = hap.Characteristic;
    return [
      [this.service, C.AirQuality],
      [this.service, C.PM2_5Density],
      [this.service, C.PM10Density],
      [this.serviceTemp, C.CurrentTemperature],
      [this.serviceCO2, C.CarbonDioxideLevel],
      [this.serviceCO2, C.CarbonDioxideDetected],
      [this.serviceHumid, C.CurrentRelativeHumidity],
    ];
  }

  // Model-dependent readings, created lazily by the first payload that carries them.
  // They are deliberately absent from coreReadings(): a sensor the device doesn't have
  // would otherwise sit in an error state forever and strand the whole accessory on
  // "No Response". Only mark them when they already exist on the service.
  private optionalReadings(): Array<[Service, CharacteristicClass]> {
    const C = hap.Characteristic;
    const entries: Array<[Service, CharacteristicClass]> = [];

    if (this.service.testCharacteristic(C.VOCDensity)) {
      entries.push([this.service, C.VOCDensity]);
    }
    if (this.service.testCharacteristic(C.NitrogenDioxideDensity)) {
      entries.push([this.service, C.NitrogenDioxideDensity]);
    }

    return entries;
  }

  // Puts readings into an error state, which HomeKit surfaces as "No Response". Pushing a
  // number instead would look like a real measurement to the Home app and to any automation
  // watching temperature or CO2. The next accepted reading clears the status by itself.
  private markReadingsUnavailable(reason: string, includeOptional = false) {
    const entries = includeOptional
      ? [...this.coreReadings(), ...this.optionalReadings()]
      : this.coreReadings();

    for (const [service, characteristic] of entries) {
      service.updateCharacteristic(characteristic, new Error(reason));
    }
  }

  // Writes the accessory's identity onto the AccessoryInformation service from
  // accessory.context, which Homebridge persists in cachedAccessories.
  private applyAccessoryInformation() {
    const info = this.accessory.getService(hap.Service.AccessoryInformation)
      || this.accessory.addService(hap.Service.AccessoryInformation);

    const context = this.accessory.context;
    const serial = toIdentityString(context.serial) || toIdentityString(this.serialno);
    const model = toIdentityString(context.model) || 'AirGradient Sensor';
    const firmware = toFirmwareRevision(context.firmwareVersion);

    info.setCharacteristic(hap.Characteristic.Manufacturer, 'AirGradient');
    info.setCharacteristic(hap.Characteristic.Model, model);

    if (serial) {
      info.setCharacteristic(hap.Characteristic.SerialNumber, serial);
    } else {
      this.log.warn(
        `Serial number "${this.serialno}" is too short for HomeKit (needs more than 1 character); ` +
        'leaving the SerialNumber characteristic unset.',
      );
    }

    if (firmware) {
      info.setCharacteristic(hap.Characteristic.FirmwareRevision, firmware);
    }
  }

  // The device reports its own model and firmware, but only once a poll succeeds.
  // Cache them on the accessory so the next restart has them immediately.
  private refreshAccessoryInformation(data: AirGradientData) {
    const model = toIdentityString(data.model);
    const firmware = readFirmwareRevision(data);
    const context = this.accessory.context;

    // Surface the payload keys once so an unrecognised firmware field is diagnosable.
    if (!firmware && !this.firmwareLookupWarned) {
      this.firmwareLookupWarned = true;
      this.log.warn(
        'No firmware version found in the AirGradient response; HomeKit will show 0.0.0. ' +
        `Looked for ${FIRMWARE_KEYS.join(', ')}. Keys returned: ${Object.keys(data).join(', ')}`,
      );
    }

    let changed = false;

    if (model && model !== context.model) {
      context.model = model;
      changed = true;
    }

    if (firmware && firmware !== context.firmwareVersion) {
      context.firmwareVersion = firmware;
      changed = true;
    }

    if (changed) {
      this.applyAccessoryInformation();
      this.log.info(
        `Accessory information updated - Model: ${context.model}, ` +
        `Firmware: ${context.firmwareVersion || 'unknown'}, Serial: ${this.serialno}`,
      );
    }
  }

  // Returns the payload, or null if the request failed or the response was unusable.
  // Either way HomeKit keeps its current values rather than being fed garbage.
  private async fetchData(): Promise<AirGradientData | null> {
    try {
      const response = await axios.get<AirGradientData>(this.apiUrl, {
        timeout: 30000,
        headers: { 'Accept': 'application/json' },
      });

      const payload = response.data;

      if (!isAirGradientData(payload)) {
        if (this.fetchLogs) {
          if (this.verboseLogs) {
            this.log.error('AirGradient API returned unexpected data format:', payload);
          } else {
            this.log.error('AirGradient API returned unexpected data format.');
          }
        }
        return null;
      }

      if (this.fetchLogs) {
        if (this.verboseLogs) {
          this.log.info('Data fetched successfully:', payload);
        } else {
          this.log.info('Data fetched successfully.');
        }
      }
      this.log.debug('API response:', payload);

      return payload;
    } catch (err) {
      this.logFetchError(err);
      return null;
    }
  }

  // Make axios/network errors readable without losing detail.
  private logFetchError(err: unknown) {
    if (!this.fetchLogs) {
      return;
    }

    if (axios.isAxiosError(err)) {
      if (this.verboseLogs) {
        this.log.error(
          `Axios error fetching AirGradient data: ${err.message}` +
          (err.response ? ` (status ${err.response.status})` : '') +
          (err.code ? ` [code ${err.code}]` : ''),
        );
        if (err.response?.data) {
          this.log.debug('Error response body:', err.response.data);
        }
      } else {
        const cause = (err.cause as { address?: string; port?: number; code?: string } | undefined);
        const addr = cause?.address && cause?.port ? ` ${cause.address}:${cause.port}` : '';
        const code = cause?.code || err.code || '';
        const reason = code === 'EHOSTUNREACH' ? 'host unreachable' :
          code === 'ECONNREFUSED' ? 'connection refused' :
            code === 'ETIMEDOUT' ? 'timeout' :
              code === 'ENOTFOUND' ? 'host not found' : err.message;
        this.log.error(`Error fetching data: ${reason}${addr}`);
      }
    } else if (err instanceof Error) {
      if (this.verboseLogs) {
        this.log.error('Error fetching data from AirGradient API:', err.message);
        this.log.debug(err.stack || 'no stack');
      } else {
        this.log.error(`Error fetching data: ${err.message}`);
      }
    } else {
      this.log.error('Unknown error fetching data from AirGradient API:', err);
    }
  }

  private handlePollSuccess(data: AirGradientData) {
    if (this.offline) {
      this.log.info(`Sensor ${this.serialno} is responding again after ${this.consecutiveFailures} failed attempts.`);
      this.offline = false;
    }

    this.consecutiveFailures = 0;
    this.refreshAccessoryInformation(data);
    this.updateCharacteristics(data);
  }

  // A single missed poll is usually a Wi-Fi hiccup, so hold the last known readings and only
  // report the sensor as unavailable once it has stayed silent for the configured number of
  // attempts. An unusable payload counts too: the device answered, but told us nothing usable.
  private handlePollFailure() {
    this.consecutiveFailures++;

    if (this.offline) {
      return;
    }

    if (this.consecutiveFailures < this.offlineAfterFailures) {
      this.log.debug(
        `Poll failed (${this.consecutiveFailures} of ${this.offlineAfterFailures} before the sensor is marked offline).`,
      );
      return;
    }

    this.offline = true;
    this.log.warn(
      `No usable response from sensor ${this.serialno} after ${this.consecutiveFailures} consecutive attempts; ` +
      'reporting it as unavailable in HomeKit until it responds again.',
    );
    this.markReadingsUnavailable(`AirGradient sensor ${this.serialno} is not responding`, true);
  }

  private async updateData() {
    try {
      const data = await this.fetchData();
      if (data) {
        this.handlePollSuccess(data);
      } else {
        this.handlePollFailure();
      }
    } catch (err) {
      // fetchData swallows its own errors, so anything here is a bug on the update path.
      // Catch it regardless so a single bad poll can't stop the polling loop.
      this.log.debug('Unexpected error while updating accessory:', err);
    } finally {
      setTimeout(() => this.updateData(), this.pollingInterval);
    }
  }

  // Falls back to the raw reading when compensation is off or the device left the
  // compensated field null, which is better than pushing an empty value to HomeKit.
  private preferred(compensated: number | undefined | null, raw: number): number {
    return this.useCompensatedValues && compensated !== undefined && compensated !== null
      ? compensated
      : raw;
  }

  // Pushes one reading, returning whether it was actually accepted.
  // A sensor the device doesn't carry is absent from the payload, and some readings come
  // back below their valid range when the sensor is warming up or faulted; neither is worth
  // a warning every polling interval, so they are logged at debug and left unchanged.
  private applyReading(
    service: Service,
    characteristic: CharacteristicClass,
    label: string,
    value: number | undefined,
    min = 0,
  ): boolean {
    if (value === undefined || value === null) {
      this.log.debug(`${label} not reported by this device; leaving characteristic unchanged.`);
      return false;
    }

    if (typeof value !== 'number' || !isFinite(value)) {
      this.log.warn(`Invalid ${label} value:`, value);
      return false;
    }

    if (value < min) {
      this.log.debug(`${label} reported as ${value}, below the valid minimum of ${min}; ignoring.`);
      return false;
    }

    service.updateCharacteristic(characteristic, value);
    return true;
  }

  private updateCharacteristics(data: AirGradientData) {
    // Use compensated values if enabled and available, otherwise fall back to the raw values
    const pm2_5 = this.preferred(data.pm02Compensated, data.pm02);
    const temp = this.preferred(data.atmpCompensated, data.atmp);
    const humidity = this.preferred(data.rhumCompensated, data.rhum);

    const { pm10, tvocIndex: tvoc, noxIndex: nox, rco2: co2 } = data;
    const C = hap.Characteristic;

    const pm2_5Applied = this.applyReading(this.service, C.PM2_5Density, 'PM2.5', pm2_5);
    this.applyReading(this.service, C.PM10Density, 'PM10', pm10);
    this.applyReading(this.service, C.VOCDensity, 'TVOC', tvoc);
    this.applyReading(this.service, C.NitrogenDioxideDensity, 'NOx', nox);
    this.applyReading(this.serviceHumid, C.CurrentRelativeHumidity, 'Humidity', humidity);
    // HomeKit's valid range for temperature starts at -270C, not 0.
    this.applyReading(this.serviceTemp, C.CurrentTemperature, 'Temperature', temp, -270);
    const co2Applied = this.applyReading(this.serviceCO2, C.CarbonDioxideLevel, 'CO2', co2);

    // These two are derived, so only recompute them when their source reading was accepted.
    // Feeding NaN to calculateAirQuality() would fall through every comparison and report POOR.
    if (pm2_5Applied) {
      this.service.updateCharacteristic(C.AirQuality, this.calculateAirQuality(pm2_5));
    }
    if (co2Applied) {
      this.serviceCO2.updateCharacteristic(C.CarbonDioxideDetected, this.calculateCO2Detected(co2));
    }

    if (this.fetchLogs) {
      if (this.verboseLogs) {
        this.log.info(`Updated characteristics - PM2.5: ${pm2_5}, PM10: ${pm10}, TVOC: ${tvoc}, ` +
          `NOx: ${nox}, TEMP: ${temp}, CO2: ${co2}, Humidity: ${humidity}`);
      } else {
        this.log.info('Updated characteristics.');
      }
    }
  }

  private calculateAirQuality(pm2_5: number): number {
    if (pm2_5 <= 12) {
      return hap.Characteristic.AirQuality.EXCELLENT;
    } else if (pm2_5 <= 35.4) {
      return hap.Characteristic.AirQuality.GOOD;
    } else if (pm2_5 <= 55.4) {
      return hap.Characteristic.AirQuality.FAIR;
    } else if (pm2_5 <= 150.4) {
      return hap.Characteristic.AirQuality.INFERIOR;
    } else {
      return hap.Characteristic.AirQuality.POOR;
    }
  }

  private calculateCO2Detected(co2: number): number {
    return co2 > this.co2AlertThreshold
      ? hap.Characteristic.CarbonDioxideDetected.CO2_LEVELS_ABNORMAL
      : hap.Characteristic.CarbonDioxideDetected.CO2_LEVELS_NORMAL;
  }

}

export = (homebridge: API) => {
  hap = homebridge.hap;
  homebridge.registerPlatform('homebridge-airgradient', 'AirGradientPlatform', AirGradientPlatform);
};
