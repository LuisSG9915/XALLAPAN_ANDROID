jest.mock("@react-native-community/netinfo", () => ({
  __esModule: true,
  default: {
    fetch: jest.fn().mockResolvedValue({ type: "wifi" }),
  },
}));

jest.mock("@react-native-async-storage/async-storage", () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(),
    setItem: jest.fn(),
  },
}));

jest.mock("react-native-fs", () => ({
  __esModule: true,
  default: {
    DocumentDirectoryPath: "/documents",
    mkdir: jest.fn().mockResolvedValue(undefined),
    copyFile: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock("react-native-image-picker", () => ({
  __esModule: true,
  launchCamera: jest.fn(),
  launchImageLibrary: jest.fn(),
}));

jest.mock("realm", () => ({
  __esModule: true,
  default: {
    UpdateMode: { Modified: "modified" },
  },
}));

import RNFS from "react-native-fs";
import {
  launchCamera,
  launchImageLibrary,
} from "react-native-image-picker";
import ClienteFotosService, {
  formatClienteFotosFechaInicial,
  parseActiva,
} from "../services/ClienteFotosService";

const MAX_FOTO_SIZE_BYTES = 5 * 1024 * 1024;

const crearRealmMock = () => ({
  isClosed: false,
  objects: jest.fn().mockReturnValue({
    filtered: jest.fn().mockReturnValue([]),
  }),
  write: jest.fn((callback: () => void) => callback()),
  create: jest.fn(),
});

describe("formatClienteFotosFechaInicial", () => {
  it("envía la fecha en hora local sin sufijo UTC", () => {
    const date = new Date("2026-08-15T18:39:33.740Z");
    const expected = [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0"),
    ].join("-") + ` ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}.${String(date.getMilliseconds()).padStart(3, "0")}`;

    expect(formatClienteFotosFechaInicial(date)).toBe(expected);
    expect(formatClienteFotosFechaInicial(date)).not.toContain("T");
    expect(formatClienteFotosFechaInicial(date)).not.toContain("Z");
  });
});

describe("ClienteFotosService.getLastLogDate", () => {
  it("ignora fotos sin fecha y toma la fecha máxima válida", () => {
    const latest = new Date("2026-08-26T18:00:00.000Z");
    ClienteFotosService.setRealm({
      isClosed: false,
      objects: jest.fn().mockReturnValue([
        { fechaLog: null },
        { fechaLog: new Date("2026-08-26T12:00:00.000Z") },
        { fechaLog: latest },
      ]),
    } as any);

    expect(ClienteFotosService.getLastLogDate()).toEqual(new Date(latest.getTime() + 10));
  });
});

describe("parseActiva", () => {
  it.each([
    [true, true],
    [false, false],
    [1, true],
    [0, false],
    ["1", true],
    ["0", false],
    ["true", true],
    ["false", false],
  ])("convierte %p en %p", (value, expected) => {
    expect(parseActiva(value)).toBe(expected);
  });
});

describe("ClienteFotosService sincronización remota", () => {
  it("actualiza a inactiva una foto existente cuando el servidor devuelve 0", () => {
    const existing = {
      id: "local-26",
      idMovil: "10127-local-26",
      idServidor: 26,
      estado: "sincronizada",
      activa: true,
    };
    const realm = {
      isClosed: false,
      objects: jest.fn().mockReturnValue({
        filtered: jest.fn().mockReturnValue([existing]),
      }),
      write: jest.fn((callback: () => void) => callback()),
      create: jest.fn(),
    };

    ClienteFotosService.setRealm(realm as any);
    const count = (ClienteFotosService as any).upsertRemoteRows([
      {
        id: 26,
        idCliente: 10127,
        idMovil: "00000000-0000-0000-0000-000000000000",
        activa: 0,
      },
    ]);

    expect(count).toBe(1);
    expect(realm.create).toHaveBeenCalledWith(
      "ClienteFoto",
      expect.objectContaining({ id: "local-26", activa: false }),
      expect.anything()
    );
    expect(existing.activa).toBe(false);
  });
});

describe("ClienteFotosService.selectAndQueue", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    ClienteFotosService.setRealm(crearRealmMock() as any);
  });

  it.each([
    ["cámara", "camera", launchCamera],
    ["galería", "library", launchImageLibrary],
  ])(
    "rechaza fotografías mayores de 5 MB al recibirlas desde %s",
    async (_label, source, launcher) => {
      (launcher as jest.Mock).mockResolvedValue({
        assets: [
          {
            uri: "file:///tmp/foto.jpg",
            fileSize: MAX_FOTO_SIZE_BYTES + 1,
            type: "image/jpeg",
          },
        ],
      });
      const solicitarEtiqueta = jest.fn().mockResolvedValue("fachada");

      await expect(
        ClienteFotosService.selectAndQueue(
          1,
          10,
          source as "camera" | "library",
          solicitarEtiqueta
        )
      ).rejects.toThrow("La fotografía no puede superar los 5 MB.");

      expect(solicitarEtiqueta).not.toHaveBeenCalled();
      expect(RNFS.copyFile).not.toHaveBeenCalled();
    }
  );

  it("permite una fotografía de exactamente 5 MB", async () => {
    (launchImageLibrary as jest.Mock).mockResolvedValue({
      assets: [
        {
          uri: "file:///tmp/foto.jpg",
          fileSize: MAX_FOTO_SIZE_BYTES,
          type: "image/jpeg",
        },
      ],
    });

    await expect(
      ClienteFotosService.selectAndQueue(1, 10, "library", async () => null)
    ).resolves.toMatchObject({ idCliente: 1 });

    expect(RNFS.copyFile).toHaveBeenCalledTimes(1);
  });
});
