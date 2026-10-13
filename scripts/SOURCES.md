# Third-party runtime source

`FilePathCheckerModuleExample.dll` is the 32-bit HWP Automation security module published by Hancom on its official developer guide:

- Guide: https://developer.hancom.com/hwpautomation
- Archive: https://github.com/hancom-io/devcenter-archive/raw/main/hwp-automation/%EB%B3%B4%EC%95%88%EB%AA%A8%EB%93%88%28Automation%29.zip
- Archive SHA-256: `5D87292EFAFD7311CBA6D35E4B416AC8BFA78608A64DDE1656C8CB827B051BD8`
- DLL SHA-256: `9AC5B97C47AC8AED1E8BCA27A3EEF39411361D8F68C262509F0C40A8F9D21BB6`
- PE machine: `0x014C` (x86)

The application verifies the DLL hash before registering its own `HangulConverterFilePathChecker` value under the current user's 32-bit `HNC\HwpAutomation\Modules` registry view. It does not replace registrations owned by other applications.
