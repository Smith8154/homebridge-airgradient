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

class AirGradientSensor implements AccessoryPlugin {
  private readonly log: Logging;
  private readonly name: string;
  private readonly locationId: string;
  private readonly apiToken: string;
  private readonly pollingInterval: number;
  private readonly apiUrl: string;
  private readonly service: Service;
  private data: any;

  constructor(log: Logging, config: AccessoryConfig) {
    this.log = log;
    this.name = config.name || 'AirGradient Sensor';
    this.locationId = config.locationId;
    this.apiToken = config.apiToken;
    this.pollingInterval = config.pollingInterval || 60000; // 1 minute

    // Construct the API URL using the locationId and apiToken
    this.apiUrl = `https://api.airgradient.com/public/api/v1/locations/${this.locationId}/measures/current?token=${this.apiToken}`;

    this.service = new hap.Service.AirQualitySensor(this.name);
    this.service.getCharacteristic(hap.Characteristic.AirQuality)
      .on('get', this.handleAirQualityGet.bind(this));

    this.service.getCharacteristic(hap.Characteristic.PM2_5Density)
      .on('get', this.handlePM2_5DensityGet.bind(this));

    this.service.getCharacteristic(hap.Characteristic.PM10Density)
      .on('get', this.handlePM10DensityGet.bind(this));

    this.service.getCharacteristic(hap.Characteristic.VOCDensity)
      .on('get', this.handleVOCDensityGet.bind(this));

    this.service.getCharacteristic(hap.Characteristic.NitrogenDioxideDensity)
      .on('get', this.handleNitrogenDioxideDensityGet.bind(this));

    this.updateData();
  }

  private async updateData() {
    try {
      const response = await axios.get(this.apiUrl);
      this.data = response.data;

      // Extract the PM2.5 and PM10 values from the response
      const pm2_5 = this.data.pm02;
      const pm10 = this.data.pm10;
      const tvoc = this.data.tvocIndex;
      const nox = this.data.noxIndex;

      // Update HomeKit characteristics
      this.service.updateCharacteristic(hap.Characteristic.AirQuality, this.calculateAirQuality(pm2_5));
      this.service.updateCharacteristic(hap.Characteristic.PM2_5Density, pm2_5);
      this.service.updateCharacteristic(hap.Characteristic.PM10Density, pm10);
      this.service.updateCharacteristic(hap.Characteristic.VOCDensity, tvoc);
      this.service.updateCharacteristic(hap.Characteristic.NitrogenDioxideDensity, nox);
    } catch (error) {
      this.log.error('Error fetching data from AirGradient API:', error);
    } finally {
      // Schedule the next update
      setTimeout(() => this.updateData(), this.pollingInterval);
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
    callback(null, this.calculateAirQuality(this.data.pm02));
  }

  private handlePM2_5DensityGet(callback: (error: Error | null, value?: number) => void) {
    callback(null, this.data.pm02);
  }

  private handlePM10DensityGet(callback: (error: Error | null, value?: number) => void) {
    callback(null, this.data.pm10);
  }

  private handleVOCDensityGet(callback: (error: Error | null, value?: number) => void) {
    callback(null, this.data.pm10);
  }

  private handleNitrogenDioxideDensityGet(callback: (error: Error | null, value?: number) => void) {
    callback(null, this.data.pm10);
  }

  public getServices(): Service[] {
    return [this.service];
  }
}

export = (homebridge: API) => {
  hap = homebridge.hap;
  homebridge.registerAccessory('homebridge-airgradient', 'AirGradientSensor', AirGradientSensor);
};
