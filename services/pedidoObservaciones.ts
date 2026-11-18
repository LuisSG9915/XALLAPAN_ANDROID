const OBSERVACION_VACIA_CENTRAL = ".";

export const normalizarObservaciones = (valor: unknown): string | null => {
  const texto = String(valor ?? "").trim();
  return texto === "" || texto === OBSERVACION_VACIA_CENTRAL ? null : texto;
};
