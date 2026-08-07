jest.mock("../services/BluetoothPrinterService", () => ({
  __esModule: true,
  default: {
    ensureConnected: jest.fn().mockResolvedValue(true),
    printTicket: jest.fn().mockResolvedValue(true),
  },
}));

import BluetoothPrinterService from "../services/BluetoothPrinterService";
import TicketPrinter from "../services/TicketPrinter";

describe("TicketPrinter", () => {
  it("envía el folio exacto para imprimirlo como Code 128", async () => {
    const ticketNumber = "83668667038";

    await TicketPrinter.printSaleTicket({
      clientName: "Cliente prueba",
      paymentMethod: "TRANSFERENCIA",
      items: [],
      total: 0,
      ticketNumber,
    });

    expect(BluetoothPrinterService.printTicket).toHaveBeenCalledWith(
      expect.arrayContaining([`FOLIO: ${ticketNumber}`]),
      ticketNumber,
    );
  });
});
