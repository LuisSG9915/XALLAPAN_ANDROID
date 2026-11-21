export const normalizarObservaciones = (valor: unknown): string | null => {
  const texto = String(valor ?? "").trim();
  return texto === "" ? null : texto;
};
