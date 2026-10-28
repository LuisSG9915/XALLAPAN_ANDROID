# Archivo CCG — cambios de GPS (1.6)

Formato de seis elementos por cambio. Este archivo es la fuente consultable: cada
entrada tiene su ancla en el código y en los tests, y se localiza por el nombre
funcional.

---

## CCG-01 · Admisión de evidencia de tracking (`ok_tracking` de `fuera_de_rango`)

1. **Función:** `validarUbicacionCliente` puede acreditar una visita fuera de rango
   cuando el tracking de ruta ya persistido demuestra presencia, en lugar de
   bloquear con el modal "Fuera de rango".
2. **Condición de efecto:** lectura fuera de rango + `HABILITAR_OK_TRACKING_FUERA_DE_RANGO`
   (hoy `true`) + `HABILITAR_OK_TRACKING` (`true`) + existe un fix persistido con
   antigüedad ≤ 5 min, `accuracy ≤ 25 m` y distancia ≤ `metrosPermitidos`, y menos
   de dos fixes de veto (≤ 2 min, `accuracy ≤ 30 m`, distancia > permitido + 30 m).
3. **Subfunción:** bloque 2.9 en `services/LocationService.ts` (`corroborarPresenciaConTracking`),
   evidencia desde `BackgroundLocationService.getFixesPersistidos()`; R1 (proveedor),
   R2 (salto > 150 km/h descartado y reanclaje), R3 (veto con dos fixes).
4. **Ejecución:** `LocationService.validarUbicacionCliente(...)` → `getBestLocation`
   → si fuera de rango → 2.9 → `ok_tracking` con `ubicacion` = el fix persistido;
   rollback poniendo la bandera en `false` (no requiere rebuild de nativo).
5. **Verificación:** `npx jest __tests__/LocationService.test.ts` (T3, T4, T4b-T4f)
   y `__tests__/BackgroundLocationService.test.ts` (R1 ×4, R2 ×3); en campo,
   `sql/medicion_ok_tracking_por_version.sql` y R4 de
   `sql/verificacion_piloto_ok_tracking.sql` (toda fila `ok_tracking` debe tener
   evidencia ≤ rango y ≤ 25 m).
6. **No aplica:** cuando no hay ruta activa (sin puntos de tracking → nunca hay
   evidencia), cuando el cliente está legítimamente fuera de rango, cuando la
   lectura es `sin_permiso` (I3, jamás se aprueba) y en el candado de reubicación
   (I4, sigue exigiendo ±25 m y 3 fixes).

---

## CCG-02 · Proveedor confiable (R1)

1. **Función:** impedir que un fix de red acredite presencia.
2. **Condición:** `provider` ∈ {`gps`, desconocido} siempre; `fused` solo con
   `accuracy ≤ 20 m` y `coords.speed` finito; `network` y `passive` nunca.
3. **Subfunción:** `registrarFixPersistido` en `services/BackgroundLocationService.ts`.
4. **Ejecución:** se evalúa al escribir el fix en la bitácora; los rechazos solo
   quedan en el log (`Fix de tracking descartado por proveedor`), **no** en Realm.
5. **Verificación:** tests R1 ×4; en producción, conteo de logs / futura columna de
   proveedor (hoy la bitácora no guarda el proveedor, así que no es auditable
   retroactivamente).
6. **No aplica:** plataformas que no reportan proveedor (se aceptan para no romper
   iOS) y equipos donde el GNSS entrega fixes con `provider` vacío.

---

## CCG-03 · Salto físicamente imposible (R2)

1. **Función:** descartar fixes que implican > 150 km/h respecto al último fix
   persistido, sin contaminar la cadena de comparación.
2. **Condición:** `distancia / max(dt, 5 s) > 41.7 m/s`.
3. **Subfunción:** `registrarFixPersistido` + `distanciaMetros` (Haversine) +
   `fixDescartadoPorSalto` (reanclaje con dos fixes concordantes dentro de 3 min).
4. **Ejecución:** el fix se descarta y la base **no** se mueve; si llega otro fix que
   concuerda con el descartado, la cadena se reancla ahí.
5. **Verificación:** tests R2 ×3 (salto descartado, base intacta, reanclaje).
6. **No aplica:** saltos menores a 150 km/h (caminar, 22.8 km/h del caso 373510 pasa
   a propósito) y conducción sostenida > 150 km/h (se pierde la evidencia mientras
   dure; no es un escenario de ruta comercial).

---

## CCG-04 · Asimetría aprobar/vetar (R3)

1. **Función:** un solo fix malo no puede tumbar una visita con evidencia válida.
2. **Condición:** aprobar con 1 fix dentro de rango; vetar solo con
   `TRACKING_VETO_FIXES_MIN = 2` fixes fuera del margen.
3. **Subfunción:** `corroborarPresenciaConTracking` (`vetos`).
4. **Ejecución:** recorre los fixes del veto y corta en el segundo que supera
   `permitido + 30 m`.
5. **Verificación:** T3 (dos fixes lejanos vetan), T4c (veto manda), T4f (un fix
   lejano no veta).
6. **No aplica:** cuando el vendedor realmente se fue y hay dos fixes que lo
   confirman (ahí sí bloquea, que es lo correcto).

---

## CCG-05 · Bitácora de reubicaciones fallidas

1. **Función:** registrar en el servidor cada intento de reubicación que no llega
   a guardarse, para poder medir cuántos son y por qué fallan (antes solo existía
   un `Alert` para el vendedor).
2. **Condición de efecto:** cualquier salida temprana de `handleReubicarCliente`
   en `components/CumplimientoScreen.tsx` y `components/SalesScreen.tsx`:
   sin permiso, sin lectura GPS, precisión > 25 m o < 3 fixes, rechazo del
   servicio, o excepción.
3. **Subfunción:** `services/ReubicacionBitacora.ts` (`registrarReubicacionFallida`)
   reutiliza `GpsBitacoraService.registrarValidacion` → Realm `BitacoraValidacion`
   → `BitacoraValidacionUbicacionMovil`. No hay tabla ni endpoint nuevo.
4. **Ejecución:** se llama sin `await` (`void ...`); si la bitácora falla, solo
   queda un `console.warn` y el vendedor no ve nada distinto. Motivos:
   `reubic_sin_permiso`, `reubic_sin_gps`, `reubic_precision`, `reubic_rechazo`,
   `reubic_error` (todos ≤ 20 caracteres y con `valido = false`).
5. **Verificación:** `npx jest __tests__/ReubicacionBitacora.test.ts` (5 tests); en
   campo, filtrar por el prefijo:
   ```sql
   SELECT motivo, COUNT(*) AS intentos, COUNT(DISTINCT idUsuario) AS vendedores
   FROM BitacoraValidacionUbicacionMovil
   WHERE fecha >= DATEADD(DAY, -7, GETDATE()) AND motivo LIKE 'reubic[_]%'
   GROUP BY motivo;
   ```
6. **No aplica:** reubicaciones exitosas (esas siguen en
   `tempreubicacionesmovil`), y el caso "no hay usuario autenticado", que es un
   estado imposible en la pantalla y no un fallo de campo.

---

## Estado de los casos reportados

| caso | 1.4 | 1.6 |
|---|---|---|
| 357053 "Precisión baja" ±2066 m | resuelto por `ok_tracking` (Punto B) | igual |
| 373510 "Fuera de rango" 419 m | bloqueado, el vendedor solo tiene la X | `ok_tracking` vía bloque 2.9 |
| modal sin botones de reintento | sin cambio | sin cambio |
| reubicación "Ubicación no disponible" | sin cambio | sin cambio |
| wake lock / Doze | resuelto en 1.4 | igual |
| 1042 tracking apagado desde 2026-09-22 | sin cambio | sin cambio (requiere watchdog de ruta) |
