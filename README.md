# Homebridge AirGradient

This plugin allows you to display the air quality values from your AirGradient devices in HomeKit.

### Features

 - Use AirGradient's API to add your AirGradient devices into HomeKit
 - Add multiple AirGradient devices (specify devices by location ID)
 - Reporting values for PM 2.5, PM 10, TVOC, NOx, CO2, temperature, and humidity

### Planned Features

 - Reporting of hardware details (manufacturer, serial number, and model) into HomeKit

### Contributing

Please feel free to contribute to this project in any way you see fit. If there are any features you would like, please open an issue and I will see what I can do, or feel free to open a pull request. If you want to help clean up or optimize the code, feel free to open a PR. I do not know TypeScript at all, I just know that this works.

### Note for Version 2.0

If you are upgrading from any previous version, for some reason you have to manually delete your `cachedAccessories` file for the new polling method to work. Since I don't know what I'm doing, this could likely be solved by some other method, so if you know what I'm doing wrong, feel free to open an issue or a PR. You can find your `cachedAccessories` file by looking in the HomeBridge UI under "Storage Path". Browse to that path and delete the `cachedAccessories` file under the `accessories` folder.
