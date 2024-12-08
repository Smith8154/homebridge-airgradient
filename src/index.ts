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
  pm10: number;
  pm003Count: number;
  atmp: number;
  rhum: number;
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
  pollingInterval?: number;
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

  constructor(platform: AirGradientPlatform, accessory: PlatformAccessory, sensorConfig: SensorConfig) {
    this.platform = platform;
    this.accessory = accessory;
    this.log = platform.log;
    this.serialno = sensorConfig.serialno;
    this.pollingInterval = sensorConfig.pollingInterval || 60000; // Default to 1 minute

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

    this.setupCharacteristics();
    this.updateData();
  }

  private setupCharacteristics() {
    this.service.getCharacteristic(hap.Characteristic.AirQuality)
      .on('get', this.handleAirQualityGet.bind(this));

    this.service.getCharacteristic(hap.Characteristic.PM2_5Density)
      .on('get', this.handlePM2_5DensityGet.bind(this));

    this.service.getCharacteristic(hap.Characteristic.PM10Density)
      .on('get', this.handlePM10DensityGet.bind(this));

    this.service.addCharacteristic(hap.Characteristic.VOCDensity)
      .on('get', this.handleVOCDensityGet.bind(this));

    this.service.addCharacteristic(hap.Characteristic.NitrogenDioxideDensity)
      .on('get', this.handleNitrogenDioxideDensityGet.bind(this));

    this.serviceTemp.getCharacteristic(hap.Characteristic.CurrentTemperature)
      .on('get', this.handleCurrentTemperatureGet.bind(this));

    this.serviceCO2.getCharacteristic(hap.Characteristic.CarbonDioxideDetected)
      .on('get', this.handleCarbonDioxideDetectedGet.bind(this));

    this.serviceCO2.getCharacteristic(hap.Characteristic.CarbonDioxideLevel)
      .on('get', this.handleCarbonDioxideLevelGet.bind(this));

    this.serviceHumid.getCharacteristic(hap.Characteristic.CurrentRelativeHumidity)
      .on('get', this.handleCurrentRelativeHumidityGet.bind(this));
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
      const pm2_5 = this.data.pm02;
      const pm10 = this.data.pm10;
      const tvoc = this.data.tvocIndex;
      const nox = this.data.noxIndex;
      const temp = this.data.atmp;
      const co2 = this.data.rco2;
      const rhum = this.data.rhum;

      // Validate data before updating characteristics
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

      if (typeof rhum === 'number' && isFinite(rhum)) {
        this.serviceHumid.updateCharacteristic(hap.Characteristic.CurrentRelativeHumidity, rhum);
      } else {
        this.log.warn('Invalid Humidity value:', rhum);
      }

      this.service.updateCharacteristic(hap.Characteristic.AirQuality, this.calculateAirQuality(pm2_5));

      this.log.info(`Updated characteristics - PM2.5: ${pm2_5}, PM10: ${pm10}, TVOC: ${tvoc}, ` +
        `NOx: ${nox}, TEMP: ${temp}, CO2: ${co2}, RHUM: ${rhum}`);
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
    if (co2 <= 800) {
      return hap.Characteristic.CarbonDioxideDetected.CO2_LEVELS_NORMAL;
    } else {
      return hap.Characteristic.CarbonDioxideDetected.CO2_LEVELS_ABNORMAL;
    }
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
