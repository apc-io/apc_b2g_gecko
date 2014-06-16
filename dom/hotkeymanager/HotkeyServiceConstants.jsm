
this.EXPORTED_SYMBOLS = ["HotkeyServiceMessage", "HotkeyErrorMessage"];

this.HotkeyServiceMessage = {
  GETHOTKEYS: "HotkeyService:gethotkeys",
  GETHOMEKEY: "HotkeyService:gethomekey",
  GETMUTEKEY: "HotkeyService:getmutekey",
  GETVOLUMEUPKEY: "HotkeyService:getvolumeupkey",
  GETVOLUMEDOWNKEY: "HotkeyService:getvolumedownkey",
  BEGINEDIT: "HotkeyService:beginedit",
  ENDEDIT: "HotkeyService:endedit",
  SETHOMEKEY: "HotkeyService:sethomekey",
  SETMUTEKEY: "HotkeyService:setmutekey",
  SETVOLUMEUPKEY: "HotkeyService:setvoluemupkey",
  SETVOLUMEDOWNKEY: "HotkeyService:setvolumedownkey",
  SETKEYRESULT: "HotkeyService:setkeyresult"
};

this.HotkeyErrorMessage = {
  KEYINUSED: "HotkeyServiceError:keyinused"
};