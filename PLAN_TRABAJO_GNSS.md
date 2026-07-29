# Plan de trabajo — Inanición del GNSS en validación de visitas

**Caso base:** idUsuario 1024, sucursal 28, clientes 9949 / 9903, 2026-07-29 08:40–09:19, Moto E32(s) (MediaTek Helio G37).

**Síntoma reportado:** 17 validaciones consecutivas fallidas (`precision_baja` / `sin_senal`), `numFixes` ≤ 1, `accuracy` 200–400 m, vendedor bloqueado 17 minutos.

**Estado:** diagnóstico cerrado. El caso base resultó ser una instancia de un defecto **sistémico**: ~50 reubicaciones corruptas en 18 días, 11 vendedores, 12 sucursales (§2.4).

---

## Resumen ejecutivo

El problema no es que el vendedor esté lejos del cliente. El problema es que:
1. El GPS nunca engancha satélites (duty-cycling de 30s lo mata)
2. Cuando por fin engancha, un fix cacheado falso produce un veredicto incorrecto
3. El vendedor, bloqueado, reubica el cliente a coordenadas erróneas
4. Esto corrompe permanentemente el catálogo maestro

**Impacto medido:** ~2.7 reubicaciones corruptas/día en 11 vendedores durante 18 días.

---

## Diagnóstico del caso analizado (2026-07-29, usuario 1024)

### Cronología reconstruida

| Hora | Evento | Detalle |
|------|--------|---------|
| 08:40:22 | Inicia tracking | accuracy 200-400m (red celular, no GPS) |
| 08:52:26 - 09:09:16 | 17 intentos de validación | Todos fallan. `numFixes` 0 o 1. `tiempoMs` ~6000ms |
| 09:09:16 | Último intento | Vendedor se rinde |
| 09:09:16 - 09:12:47 | **Hueco de 2:34 sin capturas** | GPS finalmente engancha |
| 09:12:47 | Primer fix GPS real | accuracy 40m (no redondo = GPS satelital) |
| 09:13:17 - 09:14:47 | Curva de adquisición | 116m → 12m → 11m → 7.7m |
| 09:18:21 | Tracking | vendedor a 64m del cliente (±6.97m) |
| 09:18:53 | Tracking | vendedor a 39m del cliente (±6.70m) |
| **09:18:55** | **Validación falla** | `fuera_de_rango`, distancia 137m, pero tracking dice 39m |
| 09:18:59 | Vendedor reubica cliente | A coordenadas erróneas |
| 09:19:03 | Siguiente validación | `ok`, distancia 2.5m |

### Causa raíz del falso negativo de 09:18:55

El fix de validación (±6.75m, 137m de distancia) es **físicamente imposible**:
- Tracking 2 segundos antes: vendedor a 39m (±6.70m)
- Validación: vendedor a 137m
- Velocidad implícita: 98m en 2s = **176 km/h**

**Explicación:** GMS entregó un fix cacheado antiguo como primer update. El código lo aceptó porque `accuracy` era bueno (±6.75m), sin verificar:
- Que fuera reciente (`position.timestamp` se ignora)
- Que hubiera un segundo fix consistente
- Que fuera coherente con el tracking de fondo

---

## Causas raíz identificadas

### A. Duty-cycling mata el arranque en frío

**Archivo:** `services/BackgroundLocationService.ts:24,63-74`

`intervalMs = 30000` hace que Google Play Services encienda el GNSS solo un instante cada 30s. Un receptor en arranque en frío necesita tiempo continuo para decodificar efemérides (30s mínimo). Resultado: nunca engancha, devuelve fallback de red.

**Evidencia:** 30 minutos de `accuracy` 200/300/400 (valores redondos = red celular).

### B. Cada validación destruye la suscripción

**Archivo:** `services/LocationService.ts:534-537,546` → `BackgroundLocationService.ts:81-90`

Al terminar validación: `clearWatch` → `restaurarWatchDeFondo` → `stopWatch` → **0 suscriptores** → GMS apaga GNSS → vuelta al duty-cycling.

**Consecuencia:** Cada reintento borra el progreso de adquisición. Por eso 17 intentos en 17 minutos nunca convergieron.

### C. Parche nativo no bloquea fixes rancios

**Archivo:** `patches/react-native-geolocation-service+5.3.1.patch:24-28`

Faltan:
- `setWaitForAccurateLocation(true)` — GMS entrega fix grueso de red inmediatamente
- `setMaxUpdateAgeMillis(0)` — default permite ubicaciones de hasta 30s de antigüedad

### D. Un solo fix cacheado produce falsos negativos

**Archivo:** `services/LocationService.ts:636`

`getBestLocation` corta en el primer fix con `accuracy <= 15m`, sin verificar:
- Antigüedad del fix (`position.timestamp` ignorado)
- Coherencia con segundo fix
- Coherencia con tracking de fondo

**Impacto:** 50+ reubicaciones corruptas en 18 días, 11 vendedores, 12 sucursales.

### E. Reubicación sin validación de calidad

**Archivo:** `components/SalesScreen.tsx:1526-1547`

`getBestLocation` se llama sin mirar `accuracy` ni `numFixes`. Un fix de ±1266m se acepta igual que uno de ±6m.

### F. Sin límite real de reubicaciones

**Archivo:** `services/ReubicacionService.ts:90-96`

`clienteYaReubicado` solo filtra día en curso. En práctica: una vez por día, indefinidamente.

### G. Pista de auditoría vacía

**Archivo:** `services/ReubicacionService.ts:282-283`

`latitudAnterior` y `longitudAnterior` van hardcodeados a 0. Imposible medir desplazamiento sin `cat_clientes_suc_log`.

---

## Plan de ejecución por prioridad

### Prioridad 1 — Detener la sangría (Fase 6.1)

**Objetivo:** Impedir reubicaciones con fixes malos.

**Cambios en:** `components/SalesScreen.tsx:1526-1547`

```typescript
const ubicacion = await LocationService.getBestLocation(5, 10000, undefined, ...);
if (!ubicacion) {
  Alert.alert("GPS sin señal", "No se puede reubicar sin señal GPS.");
  return;
}
const accuracy = ubicacion.accuracy ?? 999;
const numFixes = this.ultimoDiagnosticoGps.numFixes;
if (accuracy > 25 || numFixes < 3) {
  Alert.alert(
    "Precisión insuficiente",
    `El GPS tiene ±${Math.round(accuracy)}m con ${numFixes} fixes.\n` +
    `Se requieren ±25m y al menos 3 fixes para reubicar.\n` +
    `Espera a cielo abierto.`
  );
  return;
}
```

**Criterio de aceptación:** Las reubicaciones legítimas del pasado (7-12 fixes) habrían pasado; las corruptas (1 fix) habrían sido bloqueadas.

**Riesgo:** Puede bloquear vendedores con GPS averiado. Mitigación: Fase 8 en paralelo.

---

### Prioridad 2 — Cerrar falsos negativos (Fase 4)

**Objetivo:** Nunca emitir `fuera_de_rango` con un solo fix o fix rancio.

#### 4.1 Exigir mínimo 2 fixes coherentes

**Archivo:** `services/LocationService.ts:636`

```typescript
// Antes:
if ((mejor.accuracy ?? 999) <= PRECISION_OBJETIVO) {
  finalizar("precisión objetivo");
  return;
}

// Después:
if ((mejor.accuracy ?? 999) <= PRECISION_OBJETIVO && lecturasRecibidas >= 2) {
  // Verificar que el segundo fix esté cerca del primero
  const tolerancia = 3 * (mejor.accuracy ?? 999);
  const distanciaEntreFixes = calcularDistancia(...);
  if (distanciaEntreFixes <= tolerancia) {
    finalizar("precisión objetivo");
    return;
  }
  // Si no, seguir escuchando
}
```

#### 4.2 Descartar fixes por antigüedad

**Archivo:** `services/LocationService.ts:598-664` (callback de `watchPosition`)

```typescript
watchId = Geolocation.watchPosition(
  (position: GeoPosition) => {
    const coords: LocationCoordinates = {
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      accuracy: position.coords.accuracy,
    };
    
    // NUEVO: descartar fixes rancios
    const edad = Date.now() - position.timestamp;
    if (edad > 3000) {
      console.log(`[LocationService] Fix descartado por antigüedad: ${edad}ms`);
      return;
    }
    
    const accuracy = coords.accuracy ?? 999;
    const transcurrido = Date.now() - inicio;
    // ... resto del código
  },
  ...
);
```

#### 4.3 Contrastar con tracking de fondo

**Archivo:** `services/BackgroundLocationService.ts:92-128`

Exponer último fix:
```typescript
class BackgroundLocationService {
  private ultimoFixTracking: { lat: number; lng: number; timestamp: number; accuracy: number } | null = null;
  
  getUltimoFixTracking() {
    return this.ultimoFixTracking;
  }
  
  private onLocationFix(coords: LocationCoordinates) {
    this.ultimoFixTracking = {
      lat: coords.latitude,
      lng: coords.longitude,
      timestamp: Date.now(),
      accuracy: coords.accuracy ?? 999,
    };
    // ... resto
  }
}
```

**Archivo:** `services/LocationService.ts:788-796` (antes de emitir `fuera_de_rango`)

```typescript
const ultimoFix = BackgroundLocationService.getInstance().getUltimoFixTracking();
if (ultimoFix && Date.now() - ultimoFix.timestamp < 10000) {
  const distancia = calcularDistancia(
    ubicacion.latitude, ubicacion.longitude,
    ultimoFix.lat, ultimoFix.lng
  );
  const tiempoTranscurrido = (Date.now() - ultimoFix.timestamp) / 1000;
  const velocidad = distancia / tiempoTranscurrido;
  
  if (velocidad > 40) { // 40 m/s = 144 km/h
    console.warn(
      `[LocationService] Fix incoherente con tracking: ${Math.round(velocidad)} m/s`
    );
    return {
      valido: false,
      motivo: "precision_baja", // NO fuera_de_rango
      distancia,
      accuracy,
      metrosPermitidos,
      ubicacion,
      ...diag,
    };
  }
}
```

#### 4.4 Nunca convertir fix incoherente en `fuera_de_rango`

Ya implementado en 4.3: si la guarda dispara, motivo = `precision_baja`.

**Criterio de aceptación:** Reproducir caso base con fixes inyectados (uno rancio + uno fresco) → veredicto es `precision_baja`, no `fuera_de_rango`.

---

### Prioridad 3 — Mantener GNSS caliente (Fase 1 + Fase 2)

**Objetivo:** Que el GPS nunca pierda enganche.

#### 1.1 Desacoplar intervalo nativo de intervalo de escritura

**Archivo:** `services/BackgroundLocationService.ts:63-74`

```typescript
// Antes:
const opciones = {
  enableHighAccuracy: true,
  interval: this.intervalMs,      // 30000
  fastestInterval: this.intervalMs, // 30000
  // ...
};

// Después:
const opciones = {
  enableHighAccuracy: true,
  interval: 1000,        // 1s - mantiene GNSS encendido
  fastestInterval: 1000, // 1s
  // ...
};
```

El downsampling a 30s para escritura ya existe en línea 101-103.

#### 1.2 Modo adaptativo

**Archivo:** `services/BackgroundLocationService.ts`

```typescript
class BackgroundLocationService {
  private modoAdquisicion = true;
  private fixesConsecutivosBuenos = 0;
  
  private ajustarIntervaloNativo(accuracy: number) {
    if (accuracy <= 30) {
      this.fixesConsecutivosBuenos++;
      if (this.fixesConsecutivosBuenos >= 2 && this.modoAdquisicion) {
        // Cambiar a modo enganchado
        this.modoAdquisicion = false;
        this.forzarIntervaloNativo({
          enableHighAccuracy: true,
          interval: 5000,        // 5s - suficiente para no apagar GNSS
          fastestInterval: 5000,
          // ...
        });
        console.log("[BackgroundLocation] GNSS enganchado, intervalo 5s");
      }
    } else if (accuracy >= 100) {
      this.fixesConsecutivosBuenos = 0;
      if (!this.modoAdquisicion) {
        // Regresar a adquisición
        this.modoAdquisicion = true;
        this.forzarIntervaloNativo({
          enableHighAccuracy: true,
          interval: 1000,
          fastestInterval: 1000,
          // ...
        });
        console.log("[BackgroundLocation] GNSS degradado, volviendo a adquisición");
      }
    }
  }
}
```

#### 2.1 No destruir suscripción en validación

**Archivo:** `services/LocationService.ts:531-563`

```typescript
const aceptar = (coords: LocationCoordinates | null, motivo: string) => {
  if (settled) return;
  settled = true;
  
  // NUEVO: restaurar watch de fondo ANTES de liberar el rápido
  this.restaurarWatchDeFondo();
  
  if (watchId !== null) {
    Geolocation.clearWatch(watchId);
    watchId = null;
  }
  // ... resto
};
```

**Criterio de aceptación:** En logcat, cero llamadas a `stopObserving` entre inicio y cierre de ruta.

---

### Prioridad 4 — Corregir parche nativo (Fase 3)

**Archivo:** `patches/react-native-geolocation-service+5.3.1.patch:16-31`

```java
// En buildLocationRequest:
LocationRequest request = LocationRequest.create()
    .setPriority(LocationRequest.PRIORITY_HIGH_ACCURACY)
    .setInterval(options.getInterval())
    .setFastestInterval(options.getFastestInterval())
    // NUEVO:
    .setWaitForAccurateLocation(true)           // Esperar GNSS, no devolver red
    .setMaxUpdateAgeMillis(0);                  // Nada de ubicaciones históricas
```

Regenerar patch: `npx patch-package react-native-geolocation-service`

**Criterio de aceptación:** Desaparecen filas con coordenadas idénticas bit a bit en capturas separadas por más de un intervalo.

---

### Prioridad 5 — Dimensionar remediación (Consultas SQL)

**Archivo:** `docs/CONSULTAS_AUDITORIA_GPS.md`

Ejecutar consultas T1, T2, T3, T4 y clasificador D1 para identificar:
- Clientes con coordenadas corruptas (clases IMPOSIBLE y CACHEADO)
- Clientes con ping-pong (se movieron y volvieron)
- Colisiones con otros clientes

**Entregable:** Lista de clientes a remediar, sin revisión manual.

---

### Prioridad 6 — Idempotencia de reubicaciones (Fase 6.6)

**Problema:** Cliente 9122 tiene 19 filas en `tempreubicacionesmovil` pero solo 1 cambio en catálogo. El mismo lote se reenvía en cada ciclo.

**Cambios:**
1. `services/ReubicacionService.ts:registrarReubicacion` — marcar como sincronizado tras 2xx
2. `services/ReubicacionService.ts:240-247` (`getReubicacionesPendientes`) — excluir sincronizados
3. Server-side: agregar clave de idempotencia en `sp_MovilesReubicacionesJSON`

**Bloquea:** Fase 6.4 (límite real de reubicaciones).

---

### Prioridad 7 — Auditoría y remediación (Fase 6.2, 6.3, 6.5, 6.7)

#### 6.2 Persistir coordenadas anteriores

**Archivo:** `services/RealmSchemas.ts:504-518`

```typescript
export const ReubicacionSchema = {
  name: "Reubicacion",
  properties: {
    // ... existentes
    latitudAnterior: "double?",
    longitudAnterior: "double?",
    accuracy: "double?",
    numFixes: "int?",
    metrosMovidos: "double?",
  },
};
```

#### 6.3 Enviar coordenadas reales

**Archivo:** `services/ReubicacionService.ts:282-283`

```typescript
// Antes:
latitudAnterior: 0,
longitudAnterior: 0,

// Después:
latitudAnterior: coordsAntes?.latitud ?? 0,
longitudAnterior: coordsAntes?.longitud ?? 0,
accuracy: diagnostico.accuracy,
numFixes: diagnostico.numFixes,
metrosMovidos: calcularDistancia(...),
```

#### 6.7 Remediar datos corrompidos

Usar resultados de D1 (clases IMPOSIBLE y CACHEADO) para revertir coordenadas erróneas.

---

### Prioridad 8 — UX y observabilidad (Fase 5)

#### 5.1 Ventana adaptativa

Si al agotar 6s no hay fix bueno, extender hasta 25s mostrando progreso.

#### 5.2 Pre-calentamiento

Arrancar escucha al abrir pantalla de cliente, no al presionar botón.

#### 5.3 Mensajes accionables

```typescript
case "sin_senal":
  Alert.alert(
    "GPS buscando satélites",
    `El GPS lleva ${Math.round(tiempoMs/1000)}s sin encontrar satélites.\n\n` +
    `• Sal a cielo abierto\n` +
    `• Verifica que no esté en modo avión\n` +
    `• Espera 2-3 minutos sin moverte`
  );
  break;
```

#### 5.4 Nuevo motivo `red_no_gnss`

Distinguir "GPS impreciso" de "GPS usando solo red celular".

---

### Prioridad 9 — Checklist de campo (Fase 8)

**En paralelo, no requiere release.**

Para cada vendedor con problemas:
- [ ] Precisión de ubicación de Google = ON
- [ ] Búsqueda de redes Wi-Fi y Bluetooth = ON
- [ ] Permiso de ubicación = "Permitir todo el tiempo" + "Ubicación precisa"
- [ ] App en "Sin restricciones" de batería
- [ ] Modo ahorro de batería desactivado
- [ ] **Prueba de cierre forzado:** con GPS atascado, forzar cierre y reabrir. Si fix se recupera en segundos → confirma hipótesis de registro rancio (Fase 7).

---

### Aplazada — Detener tracking nocturno (Fase 7)

**Razón:** El tracking nocturno no causó la imprecisión (eso fue el teléfono bajo techo). Solo registró la imposibilidad 1640 veces.

**Beneficio comprobado:** ~1640 filas de basura/noche + ahorro de batería.

**Beneficio hipotético:** Arranque limpio del GNSS por la mañana (pendiente de prueba de campo).

**Decisión:** Retomar solo si prueba de cierre forzado confirma hipótesis.

---

## Riesgos y mitigaciones

| Riesgo | Mitigación |
|--------|------------|
| Batería (GNSS siempre encendido) | Modo adaptativo (Fase 1.2). Medir consumo antes de desplegar. |
| Rebuild nativo (Fase 3) | Fase 4 es JS puro, no depende de rebuild. |
| Migración Realm (Fases 5.4, 6.2) | Agrupar en una sola migración. |
| Fase 6.1 bloquea vendedores legítimos | Umbral de `numFixes >= 3` validado contra datos históricos. |
| Fase 6.4 es decisión de negocio | Bloqueada por 6.6 (idempotencia). |
| Script SQL del repo no es el desplegado | Extraer DDL real de producción antes de Fase 6.5. |
| Sesgo en clasificador D1 | Contrastar muestra contra tracking antes de revertir masivamente. |
| GNSS averiado a nivel hardware | Fase 8 en paralelo + mensaje claro al vendedor. |

---

## Métricas de éxito

| Métrica | Antes | Después (esperado) |
|---------|-------|-------------------|
| Reubicaciones corruptas/día | ~2.7 | 0 |
| Tiempo hasta primer fix bueno (caso atípico) | 32 min | < 3 min |
| Falsos negativos en validación | ~50 en 18 días | 0 |
| Filas de basura nocturna/equipo | ~1640 | 0 (si Fase 7) |
| Validaciones que agotan timeout | 40% | < 10% |

---

## Archivos a modificar

### TypeScript (sin rebuild)
- `services/LocationService.ts` — Fases 2, 4
- `services/BackgroundLocationService.ts` — Fases 1, 2
- `services/ReubicacionService.ts` — Fases 6.2, 6.3, 6.6
- `services/RealmSchemas.ts` — Fases 5.4, 6.2
- `components/SalesScreen.tsx` — Fases 5.2, 6.1

### Nativo (requiere rebuild)
- `patches/react-native-geolocation-service+5.3.1.patch` — Fase 3

### SQL
- `docs/CONSULTAS_AUDITORIA_GPS.md` — Fase 5 (consultas)
- `sql/sp_MovilesReubicacionesJSON.sql` — Fase 6.5 (tras obtener DDL real)

---

## Próximos pasos inmediatos

1. **Hoy:** Implementar Fase 6.1 (guarda de reubicación). Cambio aislado, bajo riesgo.
2. **Esta semana:** Implementar Fase 4 (cierre de falsos negativos). JS puro, sin rebuild.
3. **Siguiente build:** Agrupar Fases 1+2+3 (GNSS caliente + parche nativo).
4. **En paralelo:** Ejecutar consultas de auditoría (Fase 5) y checklist de campo (Fase 8).
