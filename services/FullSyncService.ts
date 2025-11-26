import Realm, { UpdateMode } from "realm";
import { ALL_SCHEMAS } from "./RealmSchemas";

export interface SyncProgress {
  current: number;
  total: number;
  entity: string;
  status: "syncing" | "completed" | "error";
  message?: string;
}

export type SyncProgressCallback = (progress: SyncProgress) => void;

class FullSyncService {
  private realm: Realm | null = null;
  private isInitialized = false;
  private apiBaseUrl = "https://cbinfo.no-ip.info:9031";

  async initialize(): Promise<void> {
    if (this.isInitialized && this.realm && !this.realm.isClosed) {
      return;
    }

    try {
      this.realm = await Realm.open({
        path: "FullSyncDB",
        schema: ALL_SCHEMAS,
        schemaVersion: 4,
        onMigration: (oldRealm: Realm, newRealm: Realm) => {
          const newCartera = newRealm.objects("Cartera");
          for (let i = 0; i < newCartera.length; i++) {
            const obj: any = newCartera[i];
            if (typeof obj.cobrado === "undefined") {
              obj.cobrado = false;
            }
          }
        },
      });

      this.isInitialized = true;
      console.log("✅ FullSyncService inicializado correctamente");
    } catch (error) {
      console.error("❌ Error al inicializar FullSyncService:", error);
      throw error;
    }
  }

  async syncAll(
    sucursal: number = 1,
    onProgress?: SyncProgressCallback
  ): Promise<{ success: boolean; error?: string }> {
    console.log("🚀 Iniciando sincronización completa para sucursal:", sucursal);

    if (!this.isInitialized) {
      console.log("📦 Inicializando Realm...");
      await this.initialize();
      console.log("✅ Realm inicializado");
    }

    const syncTasks = [
      { name: "Usuarios", fn: () => this.syncUsuarios() },
      { name: "Productos", fn: () => this.syncProductos() },
      { name: "Precios", fn: () => this.syncPrecios() },
      { name: "Clientes", fn: () => this.syncClientesFull() },
      { name: "Inventario", fn: () => this.syncInventario(sucursal) },
      { name: "Cartera", fn: () => this.syncCartera() },
      { name: "Ventas", fn: () => this.syncVentas(sucursal) },
    ];

    const total = syncTasks.length;
    let current = 0;

    try {
      console.log(`📋 Iniciando ${total} tareas de sincronización`);

      for (const task of syncTasks) {
        current++;
        console.log(`🔄 [${current}/${total}] Iniciando sincronización de ${task.name}`);

        if (onProgress) {
          onProgress({
            current,
            total,
            entity: task.name,
            status: "syncing",
            message: `Sincronizando ${task.name}...`,
          });
        }

        const startTime = Date.now();
        const result = await task.fn();
        const duration = Date.now() - startTime;

        console.log(`⏱️ ${task.name} completado en ${duration}ms`);

        if (!result.success) {
          console.error(`❌ ERROR CRÍTICO en ${task.name}:`, {
            error: result.error,
            duration: `${duration}ms`,
            step: `${current}/${total}`,
          });

          if (onProgress) {
            onProgress({
              current,
              total,
              entity: task.name,
              status: "error",
              message: result.error || "Error desconocido",
            });
          }
          console.warn(`⚠️ Error al sincronizar ${task.name}:`, result.error);
        } else {
          console.log(`✅ ${task.name} sincronizado exitosamente:`, {
            registros: result.count || 0,
            duration: `${duration}ms`,
            step: `${current}/${total}`,
          });

          if (onProgress) {
            onProgress({
              current,
              total,
              entity: task.name,
              status: "completed",
              message: `${task.name} sincronizado (${result.count || 0} registros)`,
            });
          }
        }
      }

      // Actualizar estado de sincronización
      this.updateSyncStatus("all", true);

      if (onProgress) {
        onProgress({
          current: total,
          total,
          entity: "Completado",
          status: "completed",
          message: "✅ Sincronización completa exitosa",
        });
      }

      return { success: true };
    } catch (error: any) {
      console.error("❌ ERROR GENERAL durante la sincronización completa:", {
        error: error?.message,
        stack: error?.stack,
        currentTask: syncTasks[current - 1]?.name || "Desconocida",
        progress: `${current}/${total}`,
      });

      if (onProgress) {
        onProgress({
          current,
          total,
          entity: "Error",
          status: "error",
          message: error?.message || "Error durante la sincronización",
        });
      }

      return { success: false, error: error?.message };
    }
  }

  private async syncVentas(sucursal: number): Promise<{ success: boolean; error?: string; count?: number }> {
    console.log("📊 Iniciando syncVentas para sucursal:", sucursal);

    try {
      const url = `${this.apiBaseUrl}/api/MovilesVentas/ventas-full/${sucursal}`;
      console.log("🌐 Haciendo request a:", url);

      const response = await fetch(url);
      console.log("📡 Response status:", response.status, response.statusText);

      if (!response.ok) {
        const errorText = await response.text();
        console.error("❌ Error HTTP en syncVentas:", {
          status: response.status,
          statusText: response.statusText,
          body: errorText,
        });
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      const data = await response.json();
      console.log("📋 Datos recibidos en syncVentas:", {
        type: typeof data,
        isArray: Array.isArray(data),
        length: Array.isArray(data) ? data.length : "N/A",
        preview: Array.isArray(data) ? data.slice(0, 2) : data,
      });

      if (!Array.isArray(data)) {
        console.error("❌ Formato de datos inválido en syncVentas:", data);
        throw new Error("Respuesta inválida del servidor");
      }

      const localIdThreshold = Date.now();
      console.log("🗑️ Limpiando ventas anteriores de sucursal:", sucursal);

      this.realm!.write(() => {
        // Limpiar ventas anteriores de esta sucursal (solo ids "normales")
        const existingVentas = this.realm!.objects("Venta").filtered(
          "sucursal == $0 AND id <= $1",
          sucursal,
          localIdThreshold
        );
        console.log("🗑️ Ventas a eliminar:", existingVentas.length);
        this.realm!.delete(existingVentas);

        // Insertar nuevas ventas
        console.log("💾 Insertando", data.length, "nuevas ventas");
        let insertCount = 0;
        let errorCount = 0;

        data.forEach((venta: any, index: number) => {
          try {
            this.realm!.create("Venta", {
              id: venta.id,
              sucursal: venta.sucursal,
              noVenta: venta.noVenta,
              idMovil: venta.idMovil ?? null,
              claveProd: venta.claveProd,
              nombreProducto: venta.nombreProducto,
              cantProducto: venta.cantProducto,
              precio: venta.precio,
              importe: venta.importe,
              cveCliente: venta.cveCliente,
              nombreCliente: venta.nombreCliente,
              fecha: venta.fecha ? new Date(venta.fecha) : null,
              tipoPago: venta.tipoPago,
              descripcionMedioPago: venta.descripcionMedioPago,
              vendedor: venta.vendedor,
              folioFactura: venta.folioFactura ?? false,
              facturacionMovil: venta.facturacionMovil ?? false,
              syncedAt: new Date(),
            });
            insertCount++;
          } catch (err) {
            console.error("❌ Error insertando venta", index, ":", err, venta);
            errorCount++;
          }
        });

        console.log("📊 Resultado inserción ventas:", {
          insertadas: insertCount,
          errores: errorCount,
          total: data.length,
        });
      });

      console.log(`✅ Ventas sincronizadas: ${data.length} registros`);
      return { success: true, count: data.length };
    } catch (error: any) {
      console.error("❌ ERROR CRÍTICO en syncVentas:", {
        message: error?.message,
        stack: error?.stack,
        sucursal,
        apiBaseUrl: this.apiBaseUrl,
      });
      return { success: false, error: error?.message };
    }
  }

  private async syncUsuarios(): Promise<{
    success: boolean;
    error?: string;
    count?: number;
  }> {
    console.log("👥 Iniciando syncUsuarios");

    try {
      const url = `${this.apiBaseUrl}/api/MovilesVentas/usuarios/full`;
      console.log("🌐 Haciendo request a:", url);

      const response = await fetch(url);
      console.log("📡 Response status syncUsuarios:", response.status, response.statusText);

      if (!response.ok) {
        const errorText = await response.text();
        console.error("❌ Error HTTP en syncUsuarios:", {
          status: response.status,
          statusText: response.statusText,
          body: errorText,
        });
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      const data = await response.json();
      console.log("📋 Datos recibidos en syncUsuarios:", {
        type: typeof data,
        isArray: Array.isArray(data),
        length: Array.isArray(data) ? data.length : "N/A",
        preview: Array.isArray(data) ? data.slice(0, 2) : data,
      });

      if (!Array.isArray(data)) {
        console.error("❌ Formato de datos inválido en syncUsuarios:", data);
        throw new Error("Respuesta inválida del servidor");
      }

      console.log("💾 Insertando", data.length, "usuarios en Realm");
      let insertCount = 0;
      let errorCount = 0;

      this.realm!.write(() => {
        data.forEach((usuario: any, index: number) => {
          try {
            this.realm!.create(
              "Usuario",
              {
                id: usuario.id,
                nombre: usuario.nombre,
                perfil: usuario.perfil,
                descripcionPerfil: usuario.descripcionPerfil,
                puesto: usuario.puesto,
                descripcionPuesto: usuario.descripcionPuesto,
                claveEmpleado: usuario.claveEmpleado,
                password: usuario.password,
                sucursalOrigen: usuario.sucursalOrigen,
                syncedAt: new Date(),
              },
              UpdateMode.Modified
            );
            insertCount++;
          } catch (err) {
            console.error("❌ Error insertando usuario", index, ":", err, usuario);
            errorCount++;
          }
        });
      });

      console.log("📊 Resultado inserción usuarios:", {
        insertados: insertCount,
        errores: errorCount,
        total: data.length,
      });

      console.log(`✅ Usuarios sincronizados: ${data.length} registros`);
      return { success: true, count: data.length };
    } catch (error: any) {
      console.error("❌ ERROR CRÍTICO en syncUsuarios:", {
        message: error?.message,
        stack: error?.stack,
        apiBaseUrl: this.apiBaseUrl,
      });
      return { success: false, error: error?.message };
    }
  }

  private async syncProductos(): Promise<{
    success: boolean;
    error?: string;
    count?: number;
  }> {
    console.log("📦 Iniciando syncProductos");

    try {
      const url = `${this.apiBaseUrl}/api/MovilesVentas/productos/full`;
      console.log("🌐 Haciendo request a:", url);

      const response = await fetch(url);
      console.log("📡 Response status syncProductos:", response.status, response.statusText);

      if (!response.ok) {
        const errorText = await response.text();
        console.error("❌ Error HTTP en syncProductos:", {
          status: response.status,
          statusText: response.statusText,
          body: errorText,
        });
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      const data = await response.json();
      console.log("📋 Datos recibidos en syncProductos:", {
        type: typeof data,
        isArray: Array.isArray(data),
        length: Array.isArray(data) ? data.length : "N/A",
        preview: Array.isArray(data) ? data.slice(0, 2) : data,
      });

      if (!Array.isArray(data)) {
        console.error("❌ Formato de datos inválido en syncProductos:", data);
        throw new Error("Respuesta inválida del servidor");
      }

      console.log("💾 Insertando", data.length, "productos en Realm");
      let insertCount = 0;
      let errorCount = 0;

      this.realm!.write(() => {
        data.forEach((producto: any, index: number) => {
          try {
            this.realm!.create(
              "Producto",
              {
                id: producto.id,
                claveProd: producto.claveProd,
                descripcion: producto.descripcion,
                esKit: producto.esKit ?? false,
                fechaAct: producto.fechaAct ? new Date(producto.fechaAct) : null,
                syncedAt: new Date(),
              },
              UpdateMode.Modified
            );
            insertCount++;
          } catch (err) {
            console.error("❌ Error insertando producto", index, ":", err, producto);
            errorCount++;
          }
        });
      });

      console.log("📊 Resultado inserción productos:", {
        insertados: insertCount,
        errores: errorCount,
        total: data.length,
      });

      console.log(`✅ Productos sincronizados: ${data.length} registros`);
      return { success: true, count: data.length };
    } catch (error: any) {
      console.error("❌ ERROR CRÍTICO en syncProductos:", {
        message: error?.message,
        stack: error?.stack,
        apiBaseUrl: this.apiBaseUrl,
      });
      return { success: false, error: error?.message };
    }
  }

  private async syncPrecios(): Promise<{
    success: boolean;
    error?: string;
    count?: number;
  }> {
    console.log("💰 Iniciando syncPrecios");

    try {
      const url = `${this.apiBaseUrl}/api/MovilesVentas/precios/full`;
      console.log("🌐 Haciendo request a:", url);

      const response = await fetch(url);
      console.log("📡 Response status syncPrecios:", response.status, response.statusText);

      if (!response.ok) {
        const errorText = await response.text();
        console.error("❌ Error HTTP en syncPrecios:", {
          status: response.status,
          statusText: response.statusText,
          body: errorText,
        });
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      const data = await response.json();
      console.log("📋 Datos recibidos en syncPrecios:", {
        type: typeof data,
        isArray: Array.isArray(data),
        length: Array.isArray(data) ? data.length : "N/A",
        preview: Array.isArray(data) ? data.slice(0, 2) : data,
      });

      if (!Array.isArray(data)) {
        console.error("❌ Formato de datos inválido en syncPrecios:", data);
        throw new Error("Respuesta inválida del servidor");
      }

      console.log("💾 Insertando", data.length, "precios en Realm");
      let insertCount = 0;
      let errorCount = 0;

      this.realm!.write(() => {
        data.forEach((precio: any, index: number) => {
          try {
            this.realm!.create(
              "Precio",
              {
                id: String(precio.id),
                descripcion: precio.descripcion,
                idCliente: precio.idCliente,
                claveProd: precio.claveProd,
                precio: precio.precio,
                fechaAct: precio.fechaAct ? new Date(precio.fechaAct) : null,
                syncedAt: new Date(),
              },
              UpdateMode.Modified
            );
            insertCount++;
          } catch (err) {
            console.error("❌ Error insertando precio", index, ":", err, precio);
            errorCount++;
          }
        });
      });

      console.log("📊 Resultado inserción precios:", {
        insertados: insertCount,
        errores: errorCount,
        total: data.length,
      });

      console.log(`✅ Precios sincronizados: ${data.length} registros`);
      return { success: true, count: data.length };
    } catch (error: any) {
      console.error("❌ ERROR CRÍTICO en syncPrecios:", {
        message: error?.message,
        stack: error?.stack,
        apiBaseUrl: this.apiBaseUrl,
      });
      return { success: false, error: error?.message };
    }
  }

  private async syncInventario(
    sucursal: number,
    fechaMovto?: string
  ): Promise<{ success: boolean; error?: string; count?: number }> {
    console.log("📋 Iniciando syncInventario para sucursal:", sucursal, "fecha:", fechaMovto);

    try {
      // Si no se proporciona fecha, usar fecha LOCAL (YYYY-MM-DD) del dispositivo
      const effectiveFechaMovto =
        fechaMovto ??
        (() => {
          const now = new Date();
          const yyyy = now.getFullYear();
          const mm = String(now.getMonth() + 1).padStart(2, "0");
          const dd = String(now.getDate()).padStart(2, "0");
          return `${yyyy}-${mm}-${dd}`;
        })();

      console.log("📅 Fecha efectiva para inventario:", effectiveFechaMovto);

      const url = `${this.apiBaseUrl}/api/MovilesVentas/inventario/erp-movil?sucursal=${sucursal}&fechaMovto=${effectiveFechaMovto}`;
      console.log(effectiveFechaMovto);
      console.log("🌐 Haciendo request a:", url);

      const response = await fetch(url);
      console.log("📡 Response status syncInventario:", response.status, response.statusText);

      if (!response.ok) {
        const errorText = await response.text();
        console.error("❌ Error HTTP en syncInventario:", {
          status: response.status,
          statusText: response.statusText,
          body: errorText,
        });
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      const data = await response.json();
      console.log("📋 Datos recibidos en syncInventario:", {
        type: typeof data,
        isArray: Array.isArray(data),
        length: Array.isArray(data) ? data.length : "N/A",
        preview: Array.isArray(data) ? data.slice(0, 2) : data,
      });

      if (!Array.isArray(data)) {
        console.error("❌ Formato de datos inválido en syncInventario:", data);
        throw new Error("Respuesta inválida del servidor");
      }

      const localIdThreshold = Date.now();
      const unsyncedSentinel = new Date(0);
      console.log("🗑️ Limpiando inventario anterior");

      this.realm!.write(() => {
        // Limpiar inventario anterior de TODAS las sucursales.
        // Se borran:
        // - Todos los registros con id "normal" (<= Date.now()).
        // - Cualquier registro ya sincronizado (syncedAt != fecha centinela),
        //   incluso si su id es mayor a Date.now().
        // Se conservan únicamente los movimientos locales no sincronizados
        // (id > Date.now() y syncedAt == new Date(0)).
        const existingInventario = this.realm!.objects("Inventario").filtered(
          "id <= $0 OR syncedAt != $1",
          localIdThreshold,
          unsyncedSentinel
        );
        console.log("🗑️ Registros de inventario a eliminar:", existingInventario.length);
        this.realm!.delete(existingInventario);

        // Insertar nuevo inventario
        console.log("💾 Insertando", data.length, "nuevos registros de inventario");
        let insertCount = 0;
        let errorCount = 0;

        data.forEach((inventario: any, index: number) => {
          try {
            this.realm!.create("Inventario", {
              id: inventario.id,
              sucursal: inventario.sucursal,
              claveProd: inventario.claveProd,
              fechaArrastre: inventario.fechaArrastre ? new Date(inventario.fechaArrastre) : null,
              saldo: inventario.saldo,
              descripcion: inventario.descripcion ?? null,
              syncedAt: new Date(),
            });
            insertCount++;
          } catch (err) {
            console.error("❌ Error insertando inventario", index, ":", err, inventario);
            errorCount++;
          }
        });

        console.log("📊 Resultado inserción inventario:", {
          insertados: insertCount,
          errores: errorCount,
          total: data.length,
        });
      });

      console.log(`✅ Inventario sincronizado: ${data.length} registros`);
      return { success: true, count: data.length };
    } catch (error: any) {
      console.error("❌ ERROR CRÍTICO en syncInventario:", {
        message: error?.message,
        stack: error?.stack,
        sucursal,
        apiBaseUrl: this.apiBaseUrl,
      });
      return { success: false, error: error?.message };
    }
  }

  private async syncCartera(): Promise<{
    success: boolean;
    error?: string;
    count?: number;
  }> {
    console.log("💳 Iniciando syncCartera");

    try {
      const url = `${this.apiBaseUrl}/api/MovilesVentas/cartera/full`;
      console.log("🌐 Haciendo request a:", url);

      const response = await fetch(url);
      console.log("📡 Response status syncCartera:", response.status, response.statusText);

      if (!response.ok) {
        const errorText = await response.text();
        console.error("❌ Error HTTP en syncCartera:", {
          status: response.status,
          statusText: response.statusText,
          body: errorText,
        });
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      const data = await response.json();
      console.log("📋 Datos recibidos en syncCartera:", {
        type: typeof data,
        isArray: Array.isArray(data),
        length: Array.isArray(data) ? data.length : "N/A",
        preview: Array.isArray(data) ? data.slice(0, 2) : data,
      });

      if (!Array.isArray(data)) {
        console.error("❌ Formato de datos inválido en syncCartera:", data);
        throw new Error("Respuesta inválida del servidor");
      }

      console.log("💾 Insertando", data.length, "registros de cartera en Realm");
      let insertCount = 0;
      let errorCount = 0;

      this.realm!.write(() => {
        data.forEach((cartera: any, index: number) => {
          try {
            this.realm!.create(
              "Cartera",
              {
                id: cartera.id,
                idCliente: cartera.idCliente,
                nombreCliente: cartera.nombreCliente,
                sucursal: cartera.sucursal,
                sucursalSegmento: cartera.sucursalSegmento,
                saldo: cartera.saldo,
                fecha: cartera.fecha ? new Date(cartera.fecha) : null,
                idSegmento: cartera.idSegmento,
                noVenta: cartera.noVenta,
                syncedAt: new Date(),
              },
              UpdateMode.Modified
            );
            insertCount++;
          } catch (err) {
            console.error("❌ Error insertando cartera", index, ":", err, cartera);
            errorCount++;
          }
        });
      });

      console.log("📊 Resultado inserción cartera:", {
        insertados: insertCount,
        errores: errorCount,
        total: data.length,
      });

      console.log(`✅ Cartera sincronizada: ${data.length} registros`);
      return { success: true, count: data.length };
    } catch (error: any) {
      console.error("❌ ERROR CRÍTICO en syncCartera:", {
        message: error?.message,
        stack: error?.stack,
        apiBaseUrl: this.apiBaseUrl,
      });
      return { success: false, error: error?.message };
    }
  }

  private async syncClientesFull(): Promise<{
    success: boolean;
    error?: string;
    count?: number;
  }> {
    console.log("👤 Iniciando syncClientesFull");

    try {
      const url = `${this.apiBaseUrl}/api/MovilesVentas/clientes/full`;
      console.log("🌐 Haciendo request a:", url);

      const response = await fetch(url);
      console.log("📡 Response status syncClientesFull:", response.status, response.statusText);

      if (!response.ok) {
        const errorText = await response.text();
        console.error("❌ Error HTTP en syncClientesFull:", {
          status: response.status,
          statusText: response.statusText,
          body: errorText,
        });
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      const data = await response.json();
      console.log("📋 Datos recibidos en syncClientesFull:", {
        type: typeof data,
        isArray: Array.isArray(data),
        length: Array.isArray(data) ? data.length : "N/A",
        preview: Array.isArray(data) ? data.slice(0, 2) : data,
      });

      if (!Array.isArray(data)) {
        console.error("❌ Formato de datos inválido en syncClientesFull:", data);
        throw new Error("Respuesta inválida del servidor");
      }

      console.log("💾 Insertando", data.length, "clientes en Realm");
      let insertCount = 0;
      let errorCount = 0;

      this.realm!.write(() => {
        data.forEach((cliente: any, index: number) => {
          try {
            this.realm!.create(
              "ClienteFull",
              {
                id: cliente.id,
                nombre: cliente.nombre,
                longitud: cliente.longitud ?? 0,
                latitud: cliente.latitud ?? 0,
                idGrupo: cliente.idGrupo,
                credito: cliente.credito ?? false,
                facturacionMovil: cliente.facturacionMovil ?? false,
                fechaAct: cliente.fechaAct ? new Date(cliente.fechaAct) : null,
                syncedAt: new Date(),
              },
              UpdateMode.Modified
            );
            insertCount++;
          } catch (err) {
            console.error("❌ Error insertando cliente", index, ":", err, cliente);
            errorCount++;
          }
        });
      });

      console.log("📊 Resultado inserción clientes:", {
        insertados: insertCount,
        errores: errorCount,
        total: data.length,
      });

      console.log(`✅ Clientes sincronizados: ${data.length} registros`);
      return { success: true, count: data.length };
    } catch (error: any) {
      console.error("❌ ERROR CRÍTICO en syncClientesFull:", {
        message: error?.message,
        stack: error?.stack,
        apiBaseUrl: this.apiBaseUrl,
      });
      return { success: false, error: error?.message };
    }
  }

  private updateSyncStatus(entity: string, success: boolean): void {
    if (!this.realm) return;

    this.realm.write(() => {
      this.realm!.create(
        "SyncStatus",
        {
          id: entity,
          lastSyncDate: new Date(),
          status: success ? "completed" : "failed",
        },
        UpdateMode.Modified
      );
    });
  }

  async getSucursales(): Promise<{ id: number; nombre: string }[]> {
    try {
      const response = await fetch(`${this.apiBaseUrl}/api/MovilesVentas/sucursales`);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();

      if (!Array.isArray(data)) {
        throw new Error("Respuesta inválida del servidor");
      }

      return data.map((item: any) => ({
        id: Number(item.id),
        nombre: String(item.nombre),
      }));
    } catch (error: any) {
      console.error("❌ Error al obtener sucursales:", error);
      throw error;
    }
  }

  // Métodos para consultar datos
  getVentas(limit: number = 100): any[] {
    if (!this.isInitialized || !this.realm) return [];
    return Array.from(this.realm.objects("Venta").sorted("fecha", true).slice(0, limit));
  }

  getVentasPaginated(offset: number = 0, limit: number = 50): any[] {
    if (!this.isInitialized || !this.realm) return [];
    return Array.from(
      this.realm
        .objects("Venta")
        .sorted("fecha", true)
        .slice(offset, offset + limit)
    );
  }

  getLocalVentasByNoVenta(noVenta: number): any[] {
    if (!this.isInitialized || !this.realm) return [];
    const unsyncedSentinel = new Date(0);
    return Array.from(
      this.realm.objects("Venta").filtered("noVenta == $0 AND syncedAt == $1", noVenta, unsyncedSentinel)
    );
  }

  /**
   * Crea ventas locales en Realm (una fila por producto de la venta).
   * Se usa para registrar ventas hechas en el punto de venta antes de sincronizar.
   */
  async createLocalVentas(
    ventas: {
      id: number;
      sucursal?: number | null;
      noVenta?: number | null;
      idMovil?: number | null;
      claveProd?: number | null;
      nombreProducto?: string | null;
      cantProducto?: number | null;
      precio?: number | null;
      importe?: number | null;
      cveCliente?: number | null;
      nombreCliente?: string | null;
      fecha?: Date | null;
      tipoPago?: number | null;
      descripcionMedioPago?: string | null;
      vendedor?: string | null;
      folioFactura?: boolean | null;
      facturacionMovil?: boolean | null;
    }[]
  ): Promise<void> {
    if (!ventas.length) return;

    if (!this.isInitialized || !this.realm) {
      await this.initialize();
    }
    if (!this.realm) return;

    this.realm.write(() => {
      ventas.forEach((v) => {
        this.realm!.create("Venta", {
          id: v.id,
          sucursal: v.sucursal ?? null,
          noVenta: v.noVenta ?? null,
          idMovil: v.idMovil ?? null,
          claveProd: v.claveProd ?? null,
          nombreProducto: v.nombreProducto ?? null,
          cantProducto: v.cantProducto ?? null,
          precio: v.precio ?? null,
          importe: v.importe ?? null,
          cveCliente: v.cveCliente ?? null,
          nombreCliente: v.nombreCliente ?? null,
          fecha: v.fecha ?? new Date(),
          tipoPago: v.tipoPago ?? null,
          descripcionMedioPago: v.descripcionMedioPago ?? null,
          vendedor: v.vendedor ?? null,
          folioFactura: v.folioFactura ?? false,
          facturacionMovil: v.facturacionMovil ?? false,
          // Fecha centinela para indicar que aún no se sincroniza
          syncedAt: new Date(0),
        });
      });
    });
  }

  /**
   * Crea movimientos locales en Inventario (por ejemplo, recepción de traspasos).
   */
  async createLocalInventarioMovements(
    movimientos: {
      id: number;
      sucursal?: number | null;
      claveProd?: number | null;
      saldo: number;
      fechaArrastre?: Date | null;
      descripcion?: string | null;
    }[]
  ): Promise<void> {
    if (!movimientos.length) return;

    if (!this.isInitialized || !this.realm) {
      await this.initialize();
    }
    if (!this.realm) return;

    this.realm.write(() => {
      movimientos.forEach((m) => {
        const idValue = Number(m.id);
        const sucursalValue = m.sucursal === null || m.sucursal === undefined ? null : Number(m.sucursal);
        const claveProdValue = m.claveProd === null || m.claveProd === undefined ? null : Number(m.claveProd);

        this.realm!.create("Inventario", {
          id: idValue,
          sucursal: sucursalValue,
          claveProd: claveProdValue,
          fechaArrastre: m.fechaArrastre ?? new Date(),
          saldo: m.saldo,
          descripcion: m.descripcion ?? null,
          // Fecha centinela para indicar que aún no se sincroniza
          syncedAt: new Date(0),
        });
      });
    });
  }

  /**
   * Crea movimientos locales en Cartera (por ejemplo, pagos registrados en Cobranza).
   */
  async createLocalCarteraMovements(
    movimientos: {
      id: number;
      idCliente?: number | null;
      nombreCliente?: string | null;
      sucursal?: number | null;
      sucursalSegmento?: number | null;
      saldo: number;
      fecha?: Date | null;
      idSegmento?: number | null;
      noVenta?: number | null;
    }[]
  ): Promise<void> {
    if (!movimientos.length) return;

    if (!this.isInitialized || !this.realm) {
      await this.initialize();
    }
    if (!this.realm) return;

    this.realm.write(() => {
      movimientos.forEach((m) => {
        this.realm!.create("Cartera", {
          id: m.id,
          idCliente: m.idCliente ?? null,
          nombreCliente: m.nombreCliente ?? null,
          sucursal: m.sucursal ?? null,
          sucursalSegmento: m.sucursalSegmento ?? null,
          saldo: m.saldo,
          fecha: m.fecha ?? new Date(),
          idSegmento: m.idSegmento ?? null,
          noVenta: m.noVenta ?? null,
          // Fecha centinela para indicar que aún no se sincroniza
          syncedAt: new Date(0),
        });
      });
    });
  }

  async markCarteraAsPaid(ids: number[]): Promise<void> {
    if (!ids.length) return;

    if (!this.isInitialized || !this.realm) {
      await this.initialize();
    }
    if (!this.realm) return;

    this.realm.write(() => {
      ids.forEach((id) => {
        const row: any = this.realm!.objectForPrimaryKey("Cartera", id);
        if (row) {
          row.cobrado = true;
        }
      });
    });
  }

  getUsuarios(limit: number = 100): any[] {
    if (!this.isInitialized || !this.realm) return [];
    return Array.from(this.realm.objects("Usuario").sorted("nombre").slice(0, limit));
  }

  getUsuariosPaginated(offset: number = 0, limit: number = 50): any[] {
    if (!this.isInitialized || !this.realm) return [];
    return Array.from(
      this.realm
        .objects("Usuario")
        .sorted("nombre")
        .slice(offset, offset + limit)
    );
  }

  getProductos(limit: number = 100): any[] {
    if (!this.isInitialized || !this.realm) return [];
    return Array.from(this.realm.objects("Producto").sorted("descripcion").slice(0, limit));
  }

  getProductosPaginated(offset: number = 0, limit: number = 50): any[] {
    if (!this.isInitialized || !this.realm) return [];
    return Array.from(
      this.realm
        .objects("Producto")
        .sorted("descripcion")
        .slice(offset, offset + limit)
    );
  }

  getPrecios(limit: number = 100): any[] {
    if (!this.isInitialized || !this.realm) return [];
    return Array.from(this.realm.objects("Precio").sorted("descripcion").slice(0, limit));
  }

  getPreciosPaginated(offset: number = 0, limit: number = 50): any[] {
    if (!this.isInitialized || !this.realm) return [];
    return Array.from(
      this.realm
        .objects("Precio")
        .sorted("descripcion")
        .slice(offset, offset + limit)
    );
  }

  getInventario(limit: number = 100): any[] {
    if (!this.isInitialized || !this.realm) return [];
    return Array.from(this.realm.objects("Inventario").slice(0, limit));
  }

  getInventarioPaginated(offset: number = 0, limit: number = 50): any[] {
    if (!this.isInitialized || !this.realm) return [];
    return Array.from(this.realm.objects("Inventario").slice(offset, offset + limit));
  }

  getCartera(limit: number = 100): any[] {
    if (!this.isInitialized || !this.realm) return [];
    return Array.from(this.realm.objects("Cartera").sorted("nombreCliente").slice(0, limit));
  }

  getCarteraPaginated(offset: number = 0, limit: number = 50): any[] {
    if (!this.isInitialized || !this.realm) return [];
    return Array.from(
      this.realm
        .objects("Cartera")
        .sorted("nombreCliente")
        .slice(offset, offset + limit)
    );
  }

  getVentasTotalEfectivoForDate(date: Date): number {
    if (!this.isInitialized || !this.realm) return 0;

    const start = new Date(date);
    start.setHours(0, 0, 0, 0);
    const end = new Date(date);
    end.setHours(23, 59, 59, 999);
    console.log(Array.from(this.realm.objects("Venta").filtered("id > 1700000000")));
    const ventas = this.realm.objects("Venta").filtered("fecha >= $0 AND fecha <= $1 AND tipoPago == 1", start, end);

    let total = 0;
    for (let i = 0; i < ventas.length; i++) {
      const v: any = ventas[i];
      total += v.importe || 0;
    }
    return total;
  }
  // {
  //     "id": 1763078957601044,
  //     "sucursal": 44,
  //     "noVenta": 1763078957601044,
  //     "claveProd": 2,
  //     "nombreProducto": "Bolsa 5Kg",
  //     "cantProducto": 1,
  //     "precio": 25,
  //     "importe": 25,
  //     "cveCliente": 942,
  //     "nombreCliente": "001 ABARROTES FASTI SAN JOSE",
  //     "fecha": "2025-11-14T00:09:17.601Z",
  //     "tipoPago": 1,
  //     "descripcionMedioPago": "Efectivo",
  //     "vendedor": "CBERP14",
  //     "folioFactura": false,
  //     "facturacionMovil": false,
  //     "syncedAt": "1970-01-01T00:00:00.000Z"
  // }
  getClientesFull(limit: number = 100): any[] {
    if (!this.isInitialized || !this.realm) return [];
    return Array.from(this.realm.objects("ClienteFull").sorted("nombre").slice(0, limit));
  }

  getClientesFullPaginated(offset: number = 0, limit: number = 50): any[] {
    if (!this.isInitialized || !this.realm) return [];
    return Array.from(
      this.realm
        .objects("ClienteFull")
        .sorted("nombre")
        .slice(offset, offset + limit)
    );
  }

  getClienteFullById(idCliente: number): any | null {
    if (!this.isInitialized || !this.realm) return null;
    const obj = this.realm.objectForPrimaryKey("ClienteFull", idCliente);
    return obj || null;
  }

  getPreciosByCliente(idCliente: number): any[] {
    if (!this.isInitialized || !this.realm) return [];
    return Array.from(this.realm.objects("Precio").filtered("idCliente == $0", idCliente));
  }

  getSyncStatus(entity: string = "all"): any {
    if (!this.isInitialized || !this.realm) return null;
    return this.realm.objectForPrimaryKey("SyncStatus", entity);
  }

  getStats(): any {
    if (!this.isInitialized || !this.realm) {
      return {
        ventas: 0,
        usuarios: 0,
        productos: 0,
        precios: 0,
        inventario: 0,
        cartera: 0,
        clientes: 0,
      };
    }

    return {
      ventas: this.realm.objects("Venta").length,
      usuarios: this.realm.objects("Usuario").length,
      productos: this.realm.objects("Producto").length,
      precios: this.realm.objects("Precio").length,
      inventario: this.realm.objects("Inventario").length,
      cartera: this.realm.objects("Cartera").length,
      clientes: this.realm.objects("ClienteFull").length,
    };
  }

  close(): void {
    if (this.realm && !this.realm.isClosed) {
      this.realm.close();
      this.isInitialized = false;
      console.log("🔒 FullSyncService cerrado");
    }
  }
}

export default new FullSyncService();
