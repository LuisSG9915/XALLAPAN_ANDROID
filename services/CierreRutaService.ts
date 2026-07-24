import Realm from "realm";
import { allSchemas } from "./RealmSchemas";

class CierreRutaService {
  private realm: Realm | null = null;

  /**
   * Inyecta la instancia de Realm desde FullSyncService
   * Evita abrir múltiples instancias del mismo Realm
   */
  setRealm(realm: Realm): void {
    this.realm = realm;
    console.log("[CierreRutaService] Realm inyectado correctamente");
  }

  private getRealm(): Realm {
    if (!this.realm || this.realm.isClosed) {
      throw new Error("[CierreRutaService] Realm no inicializado. Debe llamarse FullSyncService.initialize() primero");
    }
    return this.realm;
  }

  async getRutaStatus(sucursal: number, vendedor: number): Promise<boolean> {
    const realm = this.getRealm();
    const id = `${sucursal}-${vendedor}`;
    const cierreRuta: any = realm.objectForPrimaryKey("CierreRuta", id);

    return cierreRuta?.rutaCerrada ?? false;
  }

  async setRutaCerrada(sucursal: number, vendedor: number, cerrada: boolean): Promise<void> {
    const realm = this.getRealm();
    const id = `${sucursal}-${vendedor}`;
    const cierreRuta: any = realm.objectForPrimaryKey("CierreRuta", id);

    if (!cerrada && cierreRuta?.rutaCerrada !== true) {
      console.log(`Ruta ya abierta para sucursal ${sucursal}, vendedor ${vendedor}; no se registra otro cambio.`);
      return;
    }

    const updatedAt = new Date();
    const fechaCierre = cerrada ? updatedAt : cierreRuta?.fechaCierre ?? updatedAt;

    realm.write(() => {
      realm.create(
        "CierreRuta",
        {
          id,
          sucursal,
          vendedor,
          fechaCierre,
          rutaCerrada: cerrada,
          updatedAt,
          enviado: false, // Marcar como pendiente de sincronizar
        },
        Realm.UpdateMode.Modified
      );
    });

    console.log(`✅ Ruta ${cerrada ? "cerrada" : "abierta"} para sucursal ${sucursal}, vendedor ${vendedor}`);
  }
}

export default new CierreRutaService();
