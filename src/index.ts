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
  public readonly accessories: PlatformAccessory[] = [];

  constructor(log: Logging, config: PlatformConfig, api: API) {
    this.log = log;
    this.api = api;

    hap = api.hap;

    if (config.sensors) {
      for (const sensorConfig of config.sensors as SensorConfig[]) {
        this.log.info('Initializing sensor with serial number:', sensorConfig.serialno);
        this.addAccessory(sensorConfig);
      }
    }

    api.on('didFinishLaunching', () => {
      this.log.info('Did finish launching');
    });
  }

  addAccessory(sensorConfig: SensorConfig) {
    const uuid = hap.uuid.generate(sensorConfig.serialno);
    const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);

    if (existingAccessory) {
      this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);
      new AirGradientSensor(this, existingAccessory, sensorConfig);
    } else {
      this.log.info('Adding new accessory for serial number:', sensorConfig.serialno);
      const accessory = new this.api.platformAccessory(`AirGradient Sensor ${sensorConfig.serialno}`, uuid);
      new AirGradientSensor(this, accessory, sensorConfig);
      this.api.registerPlatformAccessories('homebridge-airgradient', 'AirGradientPlatform', [accessory]);
    }
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.accessories.push(accessory);
  }
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

    this.updateCharacteristics();
    this.updateData();
  }

  private async fetchData() {
    try {
      const response = await axios.get(this.apiUrl);
      this.data = response.data;
      this.log.info('Data fetched successfully:', this.data);

      // Log the full response for debugging
      this.log.debug('API response:', this.data);
    } catch (error) {
      this.log.error('Error fetching data from AirGradient API:', error);
      throw error;
    }
  }

  private async updateData() {
    try {
      await this.fetchData();
      if (this.data) {
        this.updateCharacteristics();
      }
    } catch (error) {
      this.log.error('Error updating data:', error);
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

      this.log.info(`Updated characteristics - PM2.5: ${pm2_5}, PM10: ${pm10}, TVOC: ${tvoc}, ` +
        `NOx: ${nox}, TEMP: ${temp}, CO2: ${co2}, Humidity: ${humidity}`);
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
