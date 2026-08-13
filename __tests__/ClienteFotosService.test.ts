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
import ClienteFotosService from "../services/ClienteFotosService";

const MAX_FOTO_SIZE_BYTES = 5 * 1024 * 1024;

const crearRealmMock = () => ({
  isClosed: false,
  objects: jest.fn().mockReturnValue({
    filtered: jest.fn().mockReturnValue([]),
  }),
  write: jest.fn((callback: () => void) => callback()),
  create: jest.fn(),
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
