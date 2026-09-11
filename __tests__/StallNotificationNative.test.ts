jest.mock("react-native", () => ({
  Platform: { OS: "android" },
  NativeModules: {
    StallNotificationModule: {
      show: jest.fn(() => Promise.resolve(true)),
      cancel: jest.fn(() => Promise.resolve(true)),
    },
  },
}));

import { NativeModules } from "react-native";
import {
  cancelStallNotification,
  showStallNotification,
} from "../services/StallNotificationNative";

const nativeModule = NativeModules.StallNotificationModule as {
  show: jest.Mock;
  cancel: jest.Mock;
};

describe("StallNotificationNative", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("publica la alerta mediante el módulo Android", async () => {
    await expect(showStallNotification("Vendedor", 4, 19.55, -96.95)).resolves.toBe(true);
    expect(nativeModule.show).toHaveBeenCalledWith("Vendedor", 4, 19.55, -96.95);
  });

  it("cancela la alerta mediante el módulo Android", async () => {
    await expect(cancelStallNotification()).resolves.toBe(true);
    expect(nativeModule.cancel).toHaveBeenCalledTimes(1);
  });
});
