# Homebridge AirGradient

This plugin allows you to display the air quality values from your AirGradient devices in HomeKit.

### Features

 - Use AirGradient's API to add your AirGradient devices into HomeKit
 - Add multiple AirGradient devices (specify devices by location ID)
 - Reporting values for PM 2.5, PM 10, TVOC, NOx, CO2, temperature, and humidity

### Planned Features

 - Reporting of hardware details (manufacturer, serial number, and model) into HomeKit

### Usage

Once the plugin is installed in Homebridge, you will need an API Token and
a Location ID from the AirGradient Dashboard.

The API Token is available on the General Settings > Connectivity menu. You will
have to enable API Access, if you haven't already:
https://app.airgradient.com/settings/place?tab=1

The Location ID is available on the Location menu, probably a 4-5 digit number:
https://app.airgradient.com/settings/location

### Contributing

Please feel free to contribute to this project in any way you see fit. If there are any features you would like, please open an issue and I will see what I can do, or feel free to open a pull request. If you want to help clean up or optimize the code, feel free to open a PR. I do not know TypeScript at all, I just know that this works.
