import { ObjectSchema } from "realm";

export class Visita {
  id!: number;
  idCliente!: number;
  ruta!: string;
  fecha!: Date;
  orden!: number;
  tipo!: number;
  visitado!: number;
  syncedAr?: string;

  static schema: ObjectSchema = {
    name: "Visita",
    primaryKey: "id",
    properties: {
      id: "int",
      idCliente: "int",
      ruta: "string",
      fecha: "date",
      orden: "int",
      tipo: "int",
      visitado: "int",
      syncedAr: "string?",
    },
  };
}
