import axios from 'axios';
import {
  API,
  AccessoryPlugin,
  AccessoryConfig,
  Service,
  Logging,
  HAP,
} from 'homebridge';

let hap: HAP;

interface AirGradientData {
  locationId: number;
  locationName: string;
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

class AirGradientSensor implements AccessoryPlugin {
  private readonly log: Logging;
  private readonly name: string;
  private readonly locationId: string;
  private readonly apiToken: string;
  private readonly pollingInterval: number;
  private readonly apiUrl: string;
  private readonly service: Service;
  private data: AirGradientData | null = null;

  constructor(log: Logging, config: AccessoryConfig) {
    this.log = log;
    this.name = config.name || 'AirGradient Sensor';
    this.locationId = config.locationId;
    this.apiToken = config.apiToken;
    this.pollingInterval = config.pollingInterval || 60000; // Default to 1 minute

    // Construct the API URL using the locationId and apiToken
    this.apiUrl = `https://api.airgradient.com/public/api/v1/locations/${this.locationId}/measures/current?token=${this.apiToken}`;

    this.service = new hap.Service.AirQualitySensor(this.name);
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
  }

  private async fetchData() {
    try {
      const response = await axios.get(this.apiUrl);
      this.data = response.data;
      this.log.info('Data fetched successfully:', this.data);
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

      this.service.updateCharacteristic(hap.Characteristic.AirQuality, this.calculateAirQuality(pm2_5));
      this.service.updateCharacteristic(hap.Characteristic.PM2_5Density, pm2_5);
      this.service.updateCharacteristic(hap.Characteristic.PM10Density, pm10);
      this.service.updateCharacteristic(hap.Characteristic.VOCDensity, tvoc);
      this.service.updateCharacteristic(hap.Characteristic.NitrogenDioxideDensity, nox);

      this.log.info(`Updated characteristics - PM2.5: ${pm2_5}, PM10: ${pm10}, TVOC: ${tvoc}, NOx: ${nox}`);
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

  public getServices(): Service[] {
    return [this.service];
  }
}

export = (homebridge: API) => {
  hap = homebridge.hap;
  homebridge.registerAccessory('homebridge-airgradient', 'AirGradientSensor', AirGradientSensor);
};
