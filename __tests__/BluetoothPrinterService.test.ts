jest.mock("@react-native-async-storage/async-storage", () => ({
  __esModule: true,
  default: {},
}));

jest.mock("react-native-bluetooth-escpos-printer", () => ({
  BluetoothManager: {},
  BluetoothEscposPrinter: {},
}));

import { normalizeCode128Data } from "../services/BluetoothPrinterService";

describe("normalizeCode128Data", () => {
  it("agrega el selector de subconjunto Code 128 B sin alterar el folio", () => {
    expect(normalizeCode128Data("83668667038")).toBe("{B83668667038");
  });

  it("rechaza valores vacíos o que no sean ASCII imprimible", () => {
    expect(normalizeCode128Data(" ")).toBeNull();
    expect(normalizeCode128Data("8366\n8667038")).toBeNull();
  });
});
