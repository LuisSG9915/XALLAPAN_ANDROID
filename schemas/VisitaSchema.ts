import { ObjectSchema } from "realm";

export class Visita {
  id!: number;
  idCliente!: number;
  ruta!: string;
  l!: boolean;
  m!: boolean;
  mi!: boolean;
  j!: boolean;
  v!: boolean;
  s!: boolean;
  d!: boolean;
  ordenL!: number;
  ordenM!: number;
  ordenMi!: number;
  ordenJ!: number;
  ordenV!: number;
  ordenS!: number;
  ordenD!: number;
  visitado!: boolean;
  fecha?: string | null;
  syncedAr?: string;

  static schema: ObjectSchema = {
    name: "Visita",
    primaryKey: "id",
    properties: {
      id: "int",
      idCliente: "int",
      ruta: "string",
      l: "bool",
      m: "bool",
      mi: "bool",
      j: "bool",
      v: "bool",
      s: "bool",
      d: "bool",
      ordenL: "int",
      ordenM: "int",
      ordenMi: "int",
      ordenJ: "int",
      ordenV: "int",
      ordenS: "int",
      ordenD: "int",
      visitado: "bool",
      fecha: "string?",
      syncedAr: "string?",
    },
  };
}
