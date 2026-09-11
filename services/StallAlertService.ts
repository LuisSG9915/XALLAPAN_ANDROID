import { calcularDistancia } from "./LocationService";

const DEFAULT_TOLERANCE_METERS = 30;
const DEFAULT_STALLED_SECONDS = 30 * 60;

type StallPoint = {
  latitud: number;
  longitud: number;
  timestamp: number;
};

export type StallEvaluation = {
  routeKey: string;
  idUsuario: number;
  nombreUsuario?: string | null;
  sucursal: number;
  latitud: number;
  longitud: number;
  timestamp?: number;
  metrosTolerancia?: number | null;
  segundosVarado?: number | null;
};

export type StallEvaluationResult = {
  isStalled: boolean;
  enteredStall: boolean;
  recovered: boolean;
  stalledMs: number;
};

class StallAlertService {
  private routeKey: string | null = null;
  private anchor: StallPoint | null = null;
  private alerted = false;

  private resetForRoute(routeKey: string): void {
    if (this.routeKey === routeKey) return;
    this.routeKey = routeKey;
    this.anchor = null;
    this.alerted = false;
  }

  async evaluate(input: StallEvaluation): Promise<StallEvaluationResult> {
    this.resetForRoute(input.routeKey);

    const tolerance = Number(input.metrosTolerancia);
    const threshold = Number(input.segundosVarado);
    const metrosTolerancia = Number.isFinite(tolerance) && tolerance > 0
      ? tolerance
      : DEFAULT_TOLERANCE_METERS;
    const segundosVarado = Number.isFinite(threshold) && threshold > 0
      ? threshold
      : DEFAULT_STALLED_SECONDS;
    const timestamp = Number(input.timestamp);
    const current: StallPoint = {
      latitud: input.latitud,
      longitud: input.longitud,
      timestamp: Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : Date.now(),
    };

    if (!this.anchor) {
      this.anchor = current;
      return { isStalled: false, enteredStall: false, recovered: false, stalledMs: 0 };
    }

    const distancia = calcularDistancia(
      this.anchor.latitud,
      this.anchor.longitud,
      current.latitud,
      current.longitud,
    );

    if (!Number.isFinite(distancia) || distancia > metrosTolerancia) {
      const recovered = this.alerted;
      this.anchor = current;
      this.alerted = false;
      return { isStalled: false, enteredStall: false, recovered, stalledMs: 0 };
    }

    const sinMovimientoMs = Math.max(0, current.timestamp - this.anchor.timestamp);
    if (this.alerted) {
      return { isStalled: true, enteredStall: false, recovered: false, stalledMs: sinMovimientoMs };
    }

    if (sinMovimientoMs < segundosVarado * 1000) {
      return { isStalled: false, enteredStall: false, recovered: false, stalledMs: sinMovimientoMs };
    }

    this.alerted = true;
    return { isStalled: true, enteredStall: true, recovered: false, stalledMs: sinMovimientoMs };
  }

  reset(): void {
    this.routeKey = null;
    this.anchor = null;
    this.alerted = false;
  }
}

export default new StallAlertService();
