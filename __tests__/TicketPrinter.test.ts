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

  it("imprime el medio de pago y aplica pago0 al total", () => {
    const lines = TicketPrinter.generateSaleTicket({
      clientName: "Cliente prueba",
      paymentMethod: "CREDITO",
      items: [
        { description: "Producto agregado", quantity: 1, price: 25, total: 25 },
      ],
      total: 0,
      pago0: true,
    });

    expect(lines.some((line) => line.includes("CREDITO") && line.includes("$0.00"))).toBe(true);
    expect(lines.some((line) => line.includes("Producto agregado"))).toBe(true);
  });
});
