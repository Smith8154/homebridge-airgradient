import axios from 'axios';
import {
  API,
  DynamicPlatformPlugin,
  PlatformAccessory,
  PlatformConfig,
  Service,
  Logging,
  HAP,
} from 'homebridge';

let hap: HAP;

interface AirGradientData {
  locationId: number;
  pm01: number;
  pm02: number;
  pm02Compensated?: number;
  pm10: number;
  pm003Count: number;
  atmp: number;
  atmpCompensated?: number;
  rhum: number;
  rhumCompensated?: number;
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
  firmwareVersion: string | null;
  tvocIndex: number;
  noxIndex: number;
}

interface SensorConfig {
  serialno: string;
  co2AlertThreshold?: number;
  pollingInterval?: number;
  useCompensatedValues?: boolean;
}


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
    this.verboseLogs = config?.verboseLogs ?? true;

    hap = api.hap;

    if (Array.isArray(config?.sensors)) {
      for (const sensorConfig of config.sensors as SensorConfig[]) {
        if (sensorConfig?.serialno) {
          this.sensorConfigs.push(sensorConfig);
          this.log.info('Queued sensor for init with serial number:', sensorConfig.serialno);
        }
      }
    }

    // Only manipulate accessories after Homebridge has finished launching, so cache restore happens first.
    this.api.on('didFinishLaunching', () => {
      this.log.info('Did finish launching');

      for (const sensorConfig of this.sensorConfigs) {
        const uuid = hap.uuid.generate(sensorConfig.serialno);
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
          this.api.registerPlatformAccessories(
            'homebridge-airgradient',
            'AirGradientPlatform',
            [accessory],
          );

          this.accessories.set(uuid, accessory);
        }
      }
    });
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.accessories.set(accessory.UUID, accessory);
  }
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
  private readonly platform: AirGradientPlatform;
  private readonly accessory: PlatformAccessory;
  private readonly log: Logging;
  private readonly serialno: string;
  private readonly pollingInterval: number;
  private readonly apiUrl: string;
  private data: AirGradientData | null = null;
  private readonly service: Service;
  private readonly serviceTemp: Service;
  private readonly serviceCO2: Service;
  private readonly serviceHumid: Service;
  private readonly useCompensatedValues: boolean;
  private readonly co2AlertThreshold: number;
  private readonly fetchLogs: boolean;
  private readonly verboseLogs: boolean;

  constructor(platform: AirGradientPlatform, accessory: PlatformAccessory, sensorConfig: SensorConfig) {
    this.platform = platform;
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

    this.fetchLogs = platform.fetchLogs;
    this.verboseLogs = platform.verboseLogs;

    // Construct the local API URL using the serialno
    this.apiUrl = `http://airgradient_${this.serialno}.local/measures/current`;

    this.accessory.getService(hap.Service.AccessoryInformation)!
      .setCharacteristic(hap.Characteristic.Manufacturer, 'AirGradient')
      .setCharacteristic(hap.Characteristic.SerialNumber, this.serialno);

    this.service = this.accessory.getService(hap.Service.AirQualitySensor) ||
      this.accessory.addService(hap.Service.AirQualitySensor);
    this.serviceTemp = this.accessory.getService(hap.Service.TemperatureSensor) ||
      this.accessory.addService(hap.Service.TemperatureSensor);
    this.serviceCO2 = this.accessory.getService(hap.Service.CarbonDioxideSensor) ||
      this.accessory.addService(hap.Service.CarbonDioxideSensor);
    this.serviceHumid = this.accessory.getService(hap.Service.HumiditySensor) ||
      this.accessory.addService(hap.Service.HumiditySensor);

    // Ensure all optional characteristics exist (getCharacteristic ensures creation for optionals)
    this.service.getCharacteristic(hap.Characteristic.AirQuality);
    this.service.getCharacteristic(hap.Characteristic.PM2_5Density);
    this.service.getCharacteristic(hap.Characteristic.PM10Density);

    if (!this.service.testCharacteristic(hap.Characteristic.VOCDensity)) {
      this.service.addCharacteristic(hap.Characteristic.VOCDensity);
    }
    if (!this.service.testCharacteristic(hap.Characteristic.NitrogenDioxideDensity)) {
      this.service.addCharacteristic(hap.Characteristic.NitrogenDioxideDensity);
    }

    this.serviceCO2.getCharacteristic(hap.Characteristic.CarbonDioxideDetected);
    this.serviceCO2.getCharacteristic(hap.Characteristic.CarbonDioxideLevel);

    // Initialize safe placeholder values so the Home hub never sees "missing" nodes

    this.service.updateCharacteristic(
      hap.Characteristic.AirQuality,
      (hap.Characteristic.AirQuality as unknown as Record<string, number>).UNKNOWN
    ?? hap.Characteristic.AirQuality.FAIR,
    );
    this.service.updateCharacteristic(hap.Characteristic.PM2_5Density, 0);
    this.service.updateCharacteristic(hap.Characteristic.PM10Density, 0);
    this.service.updateCharacteristic(hap.Characteristic.VOCDensity, 0);
    this.service.updateCharacteristic(hap.Characteristic.NitrogenDioxideDensity, 0);

    this.serviceCO2.updateCharacteristic(
      hap.Characteristic.CarbonDioxideDetected,
      hap.Characteristic.CarbonDioxideDetected.CO2_LEVELS_NORMAL,
    );
    this.serviceCO2.updateCharacteristic(hap.Characteristic.CarbonDioxideLevel, 0);

    this.serviceTemp.getCharacteristic(hap.Characteristic.CurrentTemperature);
    this.serviceTemp.updateCharacteristic(hap.Characteristic.CurrentTemperature, 0);

    this.serviceHumid.getCharacteristic(hap.Characteristic.CurrentRelativeHumidity);
    this.serviceHumid.updateCharacteristic(hap.Characteristic.CurrentRelativeHumidity, 0);

    this.updateData();
  }

  private async fetchData() {
    try {
    // Strongly type the expected payload
      const response = await axios.get<AirGradientData>(this.apiUrl, {
        timeout: 30000, // optional: avoid hanging forever
        headers: { 'Accept': 'application/json' },
      // validateStatus: (s) => s >= 200 && s < 400, // optional: treat 3xx as ok if your devices redirect
      });

      const payload = response.data;

      // Runtime validation: ensures critical numeric fields exist
      if (!isAirGradientData(payload)) {
        if (this.fetchLogs) {
          if (this.verboseLogs) {
            this.log.error('AirGradient API returned unexpected data format:', payload);
          } else {
            this.log.error('AirGradient API returned unexpected data format.');
          }
        }
        return; // keep previous this.data (so we don't overwrite with bad data)
      }

      // All good—commit and log
      this.data = payload;
      if (this.fetchLogs) {
        if (this.verboseLogs) {
          this.log.info('Data fetched successfully:', this.data);
        } else {
          this.log.info('Data fetched successfully.');
        }
      }

      // Optional extra debug
      this.log.debug('API response:', this.data);

    } catch (err) {
      if (this.fetchLogs) {
        // Make axios/network errors readable without losing detail
        const e = err as unknown;
        if (axios.isAxiosError(e)) {
          if (this.verboseLogs) {
            this.log.error(
              `Axios error fetching AirGradient data: ${e.message}` +
              (e.response ? ` (status ${e.response.status})` : '') +
              (e.code ? ` [code ${e.code}]` : ''),
            );
            if (e.response?.data) {
              this.log.debug('Error response body:', e.response.data);
            }
          } else {
            const cause = (e.cause as { address?: string; port?: number; code?: string } | undefined);
            const addr = cause?.address && cause?.port ? ` ${cause.address}:${cause.port}` : '';
            const code = cause?.code || e.code || '';
            const reason = code === 'EHOSTUNREACH' ? 'host unreachable' :
              code === 'ECONNREFUSED' ? 'connection refused' :
                code === 'ETIMEDOUT' ? 'timeout' :
                  code === 'ENOTFOUND' ? 'host not found' : e.message;
            this.log.error(`Error fetching data: ${reason}${addr}`);
          }
        } else if (e instanceof Error) {
          if (this.verboseLogs) {
            this.log.error('Error fetching data from AirGradient API:', e.message);
            this.log.debug(e.stack || 'no stack');
          } else {
            this.log.error(`Error fetching data: ${e.message}`);
          }
        } else {
          this.log.error('Unknown error fetching data from AirGradient API:', e);
        }
      }
      throw err; // keep existing control flow in updateData()
    }
  }


  private async updateData() {
    try {
      await this.fetchData();
      if (this.data) {
        this.updateCharacteristics();
      }
    } catch (error) {
      if (this.fetchLogs) {
        if (this.verboseLogs) {
          this.log.error('Error updating data:', error);
        } else {
          const e = error as { cause?: { code?: string; address?: string; port?: number } };
          const cause = e?.cause;
          const addr = cause?.address && cause?.port ? ` ${cause.address}:${cause.port}` : '';
          const code = cause?.code || '';
          const reason = code === 'EHOSTUNREACH' ? 'host unreachable' :
            code === 'ECONNREFUSED' ? 'connection refused' :
              code === 'ETIMEDOUT' ? 'timeout' :
                code === 'ENOTFOUND' ? 'host not found' :
                  (error instanceof Error ? error.message : String(error));
          this.log.error(`Error updating data: ${reason}${addr}`);
        }
      }
    } finally {
      // Schedule the next update
      setTimeout(() => this.updateData(), this.pollingInterval);
    }
  }

  private updateCharacteristics() {
    if (this.data) {
      // Use compensated values if enabled and available, otherwise fallback to the default values
      const pm2_5 = this.useCompensatedValues && this.data.pm02Compensated !== undefined
        ? this.data.pm02Compensated
        : this.data.pm02;
      const temp = this.useCompensatedValues && this.data.atmpCompensated !== undefined
        ? this.data.atmpCompensated
        : this.data.atmp;
      const humidity = this.useCompensatedValues && this.data.rhumCompensated !== undefined
        ? this.data.rhumCompensated
        : this.data.rhum;

      // Other values remain the same
      const pm10 = this.data.pm10;
      const tvoc = this.data.tvocIndex;
      const nox = this.data.noxIndex;
      const co2 = this.data.rco2;

      if (typeof pm2_5 === 'number' && isFinite(pm2_5)) {
        this.service.updateCharacteristic(hap.Characteristic.PM2_5Density, pm2_5);
      } else {
        this.log.warn('Invalid PM2.5 value:', pm2_5);
      }

      if (typeof pm10 === 'number' && isFinite(pm10)) {
        this.service.updateCharacteristic(hap.Characteristic.PM10Density, pm10);
      } else {
        this.log.warn('Invalid PM10 value:', pm10);
      }

      if (typeof tvoc === 'number' && isFinite(tvoc)) {
        this.service.updateCharacteristic(hap.Characteristic.VOCDensity, tvoc);
      } else {
        this.log.warn('Invalid TVOC value:', tvoc);
      }

      if (typeof nox === 'number' && isFinite(nox)) {
        this.service.updateCharacteristic(hap.Characteristic.NitrogenDioxideDensity, nox);
      } else {
        this.log.warn('Invalid NOx value:', nox);
      }

      if (typeof temp === 'number' && isFinite(temp)) {
        this.serviceTemp.updateCharacteristic(hap.Characteristic.CurrentTemperature, temp);
      } else {
        this.log.warn('Invalid Temperature value:', temp);
      }

      if (typeof co2 === 'number' && isFinite(co2)) {
        this.serviceCO2.updateCharacteristic(hap.Characteristic.CarbonDioxideDetected, this.calculateCO2Detected(co2));
        this.serviceCO2.updateCharacteristic(hap.Characteristic.CarbonDioxideLevel, co2);
      } else {
        this.log.warn('Invalid CO2 value:', co2);
      }

      if (typeof humidity === 'number' && isFinite(humidity)) {
        this.serviceHumid.updateCharacteristic(hap.Characteristic.CurrentRelativeHumidity, humidity);
      } else {
        this.log.warn('Invalid Humidity value:', humidity);
      }

      this.service.updateCharacteristic(hap.Characteristic.AirQuality, this.calculateAirQuality(pm2_5));

      if (this.fetchLogs) {
        if (this.verboseLogs) {
          this.log.info(`Updated characteristics - PM2.5: ${pm2_5}, PM10: ${pm10}, TVOC: ${tvoc}, ` +
            `NOx: ${nox}, TEMP: ${temp}, CO2: ${co2}, Humidity: ${humidity}`);
        } else {
          this.log.info('Updated characteristics.');
        }
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

  private handleAirQualityGet(callback: (error: Error | null, value?: number) => void) {
    if (this.data) {
      callback(null, this.calculateAirQuality(this.data.pm02));
    } else {
      callback(new Error('No data available'));
    }
  }

  private handlePM2_5DensityGet(callback: (error: Error | null, value?: number) => void) {
    if (this.data) {
      callback(null, this.data.pm02);
    } else {
      callback(new Error('No data available'));
    }
  }

  private handlePM10DensityGet(callback: (error: Error | null, value?: number) => void) {
    if (this.data) {
      callback(null, this.data.pm10);
    } else {
      callback(new Error('No data available'));
    }
  }

  private handleVOCDensityGet(callback: (error: Error | null, value?: number) => void) {
    if (this.data) {
      callback(null, this.data.tvocIndex);
    } else {
      callback(new Error('No data available'));
    }
  }

  private handleNitrogenDioxideDensityGet(callback: (error: Error | null, value?: number) => void) {
    if (this.data) {
      callback(null, this.data.noxIndex);
    } else {
      callback(new Error('No data available'));
    }
  }

  handleCurrentTemperatureGet(callback: (error: Error | null, value?: number) => void) {
    if (this.data) {
      callback(null, this.data.atmp);
    } else {
      callback(new Error('No data available'));
    }
  }

  handleCarbonDioxideDetectedGet(callback: (error: Error | null, value?: number) => void) {
    if (this.data) {
      callback(null, this.calculateCO2Detected(this.data.rco2));
    } else {
      callback(new Error('No data available'));
    }
  }

  handleCarbonDioxideLevelGet(callback: (error: Error | null, value?: number) => void) {
    if (this.data) {
      callback(null, this.data.rco2);
    } else {
      callback(new Error('No data available'));
    }
  }

  handleCurrentRelativeHumidityGet(callback: (error: Error | null, value?: number) => void) {
    if (this.data) {
      callback(null, this.data.rhum);
    } else {
      callback(new Error('No data available'));
    }
  }
}

export = (homebridge: API) => {
  hap = homebridge.hap;
  homebridge.registerPlatform('homebridge-airgradient', 'AirGradientPlatform', AirGradientPlatform);
};
