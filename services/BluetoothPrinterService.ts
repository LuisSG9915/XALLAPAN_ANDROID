import { Platform, PermissionsAndroid, Alert } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { BluetoothManager, BluetoothEscposPrinter } from "react-native-bluetooth-escpos-printer";

export interface PrinterDevice {
  name: string;
  address: string;
}

export interface PrinterStatus {
  connected: boolean;
  printer?: PrinterDevice;
}

const STORAGE_KEY = "@awesomeapp/selected_printer";

class BluetoothPrinterService {
  private currentPrinter: PrinterDevice | null = null;
  private isConnected: boolean = false;
  private readonly PRINT_OPTS = { encoding: "CP850", codepage: 2 };

  /**
   * Solicita permisos de Bluetooth en Android
   */
  async requestBluetoothPermissions(): Promise<boolean> {
    if (Platform.OS === "android") {
      try {
        if (Platform.Version >= 31) {
          // Android 12+
          const granted = await PermissionsAndroid.requestMultiple([
            PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
            PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
          ]);

          return (
            granted["android.permission.BLUETOOTH_SCAN"] === "granted" &&
            granted["android.permission.BLUETOOTH_CONNECT"] === "granted"
          );
        } else {
          // Android < 12
          const granted = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION);
          return granted === "granted";
        }
      } catch (err) {
        console.error("Error requesting Bluetooth permissions:", err);
        return false;
      }
    }
    return true; // iOS no necesita permisos explícitos
  }

  /**
   * Habilita Bluetooth
   */
  async enableBluetooth(): Promise<boolean> {
    try {
      const enabled = await BluetoothManager.isBluetoothEnabled();
      if (!enabled) {
        await BluetoothManager.enableBluetooth();
      }
      return true;
    } catch (error) {
      console.error("Error enabling Bluetooth:", error);
      return false;
    }
  }

  /**
   * Escanea impresoras Bluetooth disponibles
   */
  async scanPrinters(): Promise<PrinterDevice[]> {
    try {
      const hasPermissions = await this.requestBluetoothPermissions();
      if (!hasPermissions) {
        Alert.alert("Permisos Necesarios", "Se requieren permisos de Bluetooth para buscar impresoras");
        return [];
      }

      const isEnabled = await this.enableBluetooth();
      if (!isEnabled) {
        Alert.alert("Bluetooth", "Por favor activa el Bluetooth");
        return [];
      }

      const devices = await BluetoothManager.scanDevices();

      // La librería suele devolver un string JSON con { paired: [], found: [] }
      // pero en algunas versiones puede devolver directamente un objeto/array.
      let parsed: any;
      try {
        parsed = typeof devices === "string" ? JSON.parse(devices) : devices;
      } catch (parseError) {
        console.warn("No se pudo parsear respuesta de scanDevices:", parseError);
        parsed = devices;
      }

      let deviceList: any[] = [];
      if (Array.isArray(parsed)) {
        deviceList = parsed;
      } else if (parsed && (parsed.found || parsed.paired)) {
        deviceList = [...(parsed.found || []), ...(parsed.paired || [])];
      }

      // Asegurar dispositivos únicos por address
      const uniqueByAddress = new Map<string, any>();
      deviceList.forEach((device: any) => {
        if (device?.address && !uniqueByAddress.has(device.address)) {
          uniqueByAddress.set(device.address, device);
        }
      });

      const printers: PrinterDevice[] = Array.from(uniqueByAddress.values())
        .filter((device: any) => {
          if (!device.address) return false;
          const name = (device.name || "").toString().toUpperCase();
          // Si no tiene nombre, igual lo mostramos (genéricas)
          if (!name) return true;
          // Nombres comunes de impresoras térmicas
          return (
            name.includes("PRINTER") ||
            name.includes("THERMAL") ||
            name.includes("POS") ||
            name.includes("RP") ||
            name.includes("BT") ||
            name.includes("EC MP")
          );
        })
        .map((device: any) => ({
          name: device.name || "Dispositivo sin nombre",
          address: device.address,
        }));

      return printers;
    } catch (error) {
      console.error("Error scanning printers:", error);
      Alert.alert("Error", "No se pudo escanear impresoras Bluetooth");
      return [];
    }
  }

  /**
   * Conecta a una impresora específica
   */
  async connectToPrinter(printer: PrinterDevice, options?: { silent?: boolean }): Promise<boolean> {
    const t0 = Date.now();
    console.log(`[BTPrinter] connectToPrinter INICIO (t=0ms) -> ${printer.name} (${printer.address}), silent=${options?.silent ?? false}`);
    try {
      console.log(`[BTPrinter] connectToPrinter habilitando Bluetooth... (t=${Date.now() - t0}ms)`);
      const isEnabled = await this.enableBluetooth();
      console.log(`[BTPrinter] enableBluetooth=${isEnabled} (t=${Date.now() - t0}ms)`);
      if (!isEnabled) {
        Alert.alert("Bluetooth", "Por favor activa el Bluetooth");
        return false;
      }

      // Intentar limpiar cualquier conexión previa que haya quedado colgada
      const anyMgr = BluetoothManager as any;
      if (typeof anyMgr.disconnect === "function") {
        console.log(`[BTPrinter] disconnect() disponible, reseteando conexión previa... (t=${Date.now() - t0}ms)`);
        try {
          await anyMgr.disconnect();
          console.log(`[BTPrinter] disconnect() completado (t=${Date.now() - t0}ms)`);
        } catch (disconnectError) {
          console.warn("Error intentando resetear la conexión Bluetooth antes de conectar:", disconnectError);
        }
      } else {
        // Si disconnect no existe, verificar si ya está conectada a esta misma impresora
        try {
          const nativeConnected = await anyMgr.isConnected();
          if (nativeConnected && this.currentPrinter?.address === printer.address) {
            console.log("[Printer] Ya está conectada a esta impresora, no se requiere reconexión");
            return true;
          }
        } catch {}
      }

      console.log(`[BTPrinter] Llamando BluetoothManager.connect(${printer.address})... (t=${Date.now() - t0}ms)`);
      await BluetoothManager.connect(printer.address);
      console.log(`[BTPrinter] BluetoothManager.connect OK (t=${Date.now() - t0}ms)`);
      this.currentPrinter = printer;
      this.isConnected = true;

      // Guardar impresora seleccionada
      await this.savePrinter(printer);

      return true;
    } catch (error: any) {
      console.error(`[BTPrinter] Error connecting to printer (t=${Date.now() - t0}ms):`, error?.message || error);
      this.currentPrinter = null;
      this.isConnected = false;

      if (!options?.silent) {
        const message =
          typeof error?.message === "string"
            ? `No se pudo conectar a la impresora ${printer.name}.` + `\n\nDetalle: ${error.message}`
            : `No se pudo conectar a la impresora ${printer.name}`;

        Alert.alert("Error", message);
      }

      return false;
    }
  }

  /**
   * Desconecta de la impresora actual
   */
  async disconnect(): Promise<void> {
    try {
      if (this.isConnected && this.currentPrinter) {
        const anyMgr = BluetoothManager as any;
        if (typeof anyMgr.disconnect === "function") {
          await anyMgr.disconnect();
        }
        this.isConnected = false;
      }
    } catch (error) {
      console.error("Error disconnecting printer:", error);
    }
  }

  /**
   * Guarda la impresora seleccionada en AsyncStorage
   */
  private async savePrinter(printer: PrinterDevice): Promise<void> {
    try {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(printer));
    } catch (error) {
      console.error("Error saving printer:", error);
    }
  }

  /**
   * Carga la impresora guardada de AsyncStorage
   */
  async loadSavedPrinter(): Promise<PrinterDevice | null> {
    try {
      const saved = await AsyncStorage.getItem(STORAGE_KEY);
      if (saved) {
        return JSON.parse(saved) as PrinterDevice;
      }
      return null;
    } catch (error) {
      console.error("Error loading saved printer:", error);
      return null;
    }
  }

  /**
   * Conecta automáticamente a la última impresora usada
   */
  async connectToSavedPrinter(): Promise<boolean> {
    const t0 = Date.now();
    console.log("[BTPrinter] connectToSavedPrinter INICIO (t=0ms)");
    const savedPrinter = await this.loadSavedPrinter();
    console.log(`[BTPrinter] loadSavedPrinter terminó en ${Date.now() - t0}ms, savedPrinter=${savedPrinter ? `${savedPrinter.name} (${savedPrinter.address})` : 'null'}`);
    if (savedPrinter) {
      const result = await this.connectToPrinter(savedPrinter, { silent: true });
      console.log(`[BTPrinter] connectToSavedPrinter FIN en ${Date.now() - t0}ms, resultado=${result}`);
      return result;
    }
    console.log(`[BTPrinter] connectToSavedPrinter FIN en ${Date.now() - t0}ms (sin impresora guardada)`);
    return false;
  }

  /**
   * Obtiene el estado de la conexión
   */
  getStatus(): PrinterStatus {
    return {
      connected: this.isConnected,
      printer: this.currentPrinter || undefined,
    };
  }

  /**
   * Verifica el estado REAL de la conexión Bluetooth consultando al nativo.
   * El flag local `isConnected` puede quedar obsoleto si la impresora se apaga
   * o sale de rango, por lo que aquí intentamos validar contra el sistema.
   */
  private async isReallyConnected(): Promise<boolean> {
    try {
      const anyMgr = BluetoothManager as any;
      if (typeof anyMgr.getConnectedDeviceAddress === "function") {
        const addr = await anyMgr.getConnectedDeviceAddress();
        if (!addr) return false;
        // Si tenemos impresora actual, confirmar que coincide la dirección
        return !this.currentPrinter || addr === this.currentPrinter.address;
      }
    } catch (e) {
      console.warn("No se pudo verificar conexión real de impresora:", e);
    }
    // Si no se puede verificar nativamente, confiar en el flag local
    return this.isConnected;
  }

  /**
   * Garantiza que haya una conexión activa con la impresora.
   * Si la conexión cayó, intenta reconectar automáticamente a la impresora guardada.
   */
  async ensureConnected(): Promise<boolean> {
    // Si creemos estar conectados, verificar el estado real
    if (this.isConnected && this.currentPrinter) {
      const reallyConnected = await this.isReallyConnected();
      if (reallyConnected) return true;
      // El flag estaba obsoleto: la conexión real cayó
      console.warn("[Printer] Flag conectado pero conexión real caída. Reconectando...");
      this.isConnected = false;
    }

    // Intentar reconectar a la impresora guardada (silencioso)
    return await this.connectToSavedPrinter();
  }

  /**
   * Fuerza una reconexión limpia: desconecta y vuelve a conectar a la impresora guardada.
   */
  private async forceReconnect(): Promise<boolean> {
    try {
      const anyMgr = BluetoothManager as any;
      if (typeof anyMgr.disconnect === "function") {
        await anyMgr.disconnect();
      }
    } catch (e) {
      // ignorar errores al desconectar
    }
    this.isConnected = false;
    return await this.connectToSavedPrinter();
  }

  /**
   * Ejecuta una operación de impresión garantizando la conexión y reintentando
   * una vez si la impresora se desconectó. Centraliza la lógica de auto-reconexión
   * para que aplique en TODOS los lugares donde se imprime.
   */
  private async executeWithReconnect(printFn: () => Promise<void>): Promise<boolean> {
    // Asegurar conexión antes de imprimir (reconecta si es necesario)
    const connected = await this.ensureConnected();
    if (!connected) {
      Alert.alert(
        "Impresora no disponible",
        "No se pudo conectar a la impresora. Verifica que esté encendida, dentro de rango y vinculada.",
      );
      return false;
    }

    try {
      await printFn();
      return true;
    } catch (error) {
      console.warn("[Printer] Error al imprimir, intentando reconectar y reintentar...", error);
      // La conexión pudo caerse justo al imprimir: reconectar y reintentar una vez
      const reconnected = await this.forceReconnect();
      if (!reconnected) {
        Alert.alert(
          "Error de Impresión",
          "La impresora se desconectó y no se pudo reconectar automáticamente.",
        );
        return false;
      }
      try {
        await printFn();
        return true;
      } catch (retryError) {
        console.error("[Printer] Error al imprimir tras reconexión:", retryError);
        Alert.alert("Error de Impresión", "No se pudo imprimir el ticket.");
        return false;
      }
    }
  }

  /**
   * Imprime texto plano (con auto-reconexión)
   */
  async printText(text: string): Promise<boolean> {
    return this.executeWithReconnect(async () => {
      await BluetoothEscposPrinter.printerInit();
      await BluetoothEscposPrinter.printText(text + "\n\n\n", this.PRINT_OPTS);
    });
  }

  /**
   * Imprime líneas de ticket con formato (con auto-reconexión)
   */
  async printTicket(lines: string[]): Promise<boolean> {
    return this.executeWithReconnect(async () => {
      await BluetoothEscposPrinter.printerInit();

      for (let line of lines) {
        // Detectar si la línea tiene marcador de negrita [B]
        const isBold = line.startsWith("[B]");
        if (isBold) {
          line = line.substring(3); // Remover el marcador [B]
        }

        // Detectar líneas especiales y aplicar formato
        if (line.includes("===") || line.includes("---")) {
          // Separadores
          await BluetoothEscposPrinter.printText(line + "\n", this.PRINT_OPTS);
        } else if (
          line.toUpperCase().includes("CORTE DE RUTA") ||
          line.toUpperCase().includes("TICKET") ||
          line.toUpperCase().includes("PRECORTE") ||
          line.toUpperCase().includes("COMPROBANTE")
        ) {
          // Título centrado
          await BluetoothEscposPrinter.printText(line + "\n", {
            ...this.PRINT_OPTS,
            align: "center",
          });
        } else {
          // Texto normal (las negritas ESC/POS se manejarán con comandos si es necesario)
          await BluetoothEscposPrinter.printText(line + "\n", this.PRINT_OPTS);
        }
      }

      // Alimentación adicional
      await BluetoothEscposPrinter.printText("\n\n\n", this.PRINT_OPTS);
    });
  }

  /**
   * Imprime un ticket con encabezado formateado
   */
  async printFormattedTicket(businessName: string, title: string, lines: string[]): Promise<boolean> {
    return this.executeWithReconnect(async () => {
      await BluetoothEscposPrinter.printerInit();

      // Encabezado
      await BluetoothEscposPrinter.printText("================================\n", this.PRINT_OPTS);
      await BluetoothEscposPrinter.printText(businessName + "\n", {
        ...this.PRINT_OPTS,
        align: "center",
        widthtimes: 1,
      });
      await BluetoothEscposPrinter.printText("================================\n", this.PRINT_OPTS);
      await BluetoothEscposPrinter.printText(title + "\n", {
        ...this.PRINT_OPTS,
        align: "center",
      });
      await BluetoothEscposPrinter.printText("================================\n", this.PRINT_OPTS);

      // Contenido
      for (const line of lines) {
        await BluetoothEscposPrinter.printText(line + "\n", this.PRINT_OPTS);
      }

      // Pie
      await BluetoothEscposPrinter.printText("================================\n", this.PRINT_OPTS);
      await BluetoothEscposPrinter.printText("¡GRACIAS POR SU COMPRA!\n", {
        ...this.PRINT_OPTS,
        align: "center",
      });
      await BluetoothEscposPrinter.printText("================================\n", this.PRINT_OPTS);
      await BluetoothEscposPrinter.printText("\n\n\n", this.PRINT_OPTS);
    });
  }

  /**
   * Prueba de impresión
   */
  async printTest(): Promise<boolean> {
    try {
      const testLines = [
        "================================",
        "        PRUEBA DE IMPRESIÓN",
        "================================",
        `Fecha: ${new Date().toLocaleString("es-MX")}`,
        `Impresora: ${this.currentPrinter?.name}`,
        "================================",
        "Si puede leer esto correctamente,",
        "la impresora está funcionando.",
        "================================",
      ];

      // printTicket ya garantiza conexión y reintenta si la impresora se desconectó
      return await this.printTicket(testLines);
    } catch (error) {
      console.error("Error printing test:", error);
      return false;
    }
  }

  /**
   * Limpia la impresora guardada
   */
  async clearSavedPrinter(): Promise<void> {
    try {
      await AsyncStorage.removeItem(STORAGE_KEY);
      this.currentPrinter = null;
      this.isConnected = false;
    } catch (error) {
      console.error("Error clearing saved printer:", error);
    }
  }
}

export default new BluetoothPrinterService();
