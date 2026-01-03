import Realm from "realm";
import { ALL_SCHEMAS } from "./RealmSchemas";

class CierreRutaService {
  private realm: Realm | null = null;

  async initialize(): Promise<void> {
    if (this.realm && !this.realm.isClosed) {
      return;
    }

    try {
      this.realm = await Realm.open({
        path: "FullSyncDB",
        schema: ALL_SCHEMAS,
        schemaVersion: 11,
        onMigration: (oldRealm: Realm, newRealm: Realm) => {
          // Migración para Usuario - inicializar campo metros
          const newUsuarios = newRealm.objects("Usuario");
          for (let i = 0; i < newUsuarios.length; i++) {
            const obj: any = newUsuarios[i];
            if (typeof obj.metros === "undefined" || obj.metros === null) {
              obj.metros = 31; // Valor por defecto
            }
          }
        },
      });
      console.log("✅ CierreRutaService inicializado");
    } catch (error) {
      console.error("❌ Error al inicializar CierreRutaService:", error);
      throw error;
    }
  }

  async getRutaStatus(sucursal: number, vendedor: number): Promise<boolean> {
    await this.initialize();
    if (!this.realm) return false;

    const id = `${sucursal}-${vendedor}`;
    const cierreRuta: any = this.realm.objectForPrimaryKey("CierreRuta", id);

    return cierreRuta?.rutaCerrada ?? false;
  }

  async setRutaCerrada(sucursal: number, vendedor: number, cerrada: boolean): Promise<void> {
    await this.initialize();
    if (!this.realm) return;

    const id = `${sucursal}-${vendedor}`;

    this.realm.write(() => {
      this.realm!.create(
        "CierreRuta",
        {
          id,
          sucursal,
          vendedor,
          fechaCierre: cerrada ? new Date() : null,
          rutaCerrada: cerrada,
          updatedAt: new Date(),
        },
        Realm.UpdateMode.Modified
      );
    });

    console.log(`✅ Ruta ${cerrada ? "cerrada" : "abierta"} para sucursal ${sucursal}, vendedor ${vendedor}`);
  }
}

export default new CierreRutaService();
