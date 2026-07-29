# Plan de trabajo — Inanición del GNSS en validación de visitas

**Caso base:** idUsuario 1024, sucursal 28, clientes 9949 / 9903, 2026-07-29 08:40–09:19, Moto E32(s) (MediaTek Helio G37).
**Síntoma reportado:** 17 validaciones consecutivas fallidas (`precision_baja` / `sin_senal`), `numFixes` ≤ 1, `accuracy` 200–400 m, vendedor bloqueado 17 minutos.
**Estado:** diagnóstico cerrado. El caso base resultó ser una instancia de un defecto **sistémico**: ~50 reubicaciones corruptas en 18 días, 11 vendedores, 12 sucursales (§2.4). Consultas ejecutables en `@c:/xallapan/docs/CONSULTAS_AUDITORIA_GPS.md`.
**Correcciones a versiones previas de este plan:** el alcance en la flota (§2.1), el criterio de triaje de reubicaciones (§0.4), la interpretación de los conteos de reubicación (§0.4, son reenvíos) y la justificación de la Fase 7 (el tracking nocturno **no** causó la imprecisión).

---

## 1. Cronología reconstruida

Cruzando `BitacoraValidacionUbicacionMovil` (filas de validación + filas `recorrido_*` del tracking):

| Ventana | Qué se observa |
|---|---|
| 08:40:22 – 09:10:13 (30 min) | **Todas** las capturas de tracking traen `accuracy` ∈ {200, 300, 400, 600} — valores redondos = proveedor de **red** (celda/WiFi). Cero fixes GNSS. |
| 08:52:26 – 09:09:16 | 17 intentos de validación. Todos agotan `tiempoMs` ≈ 6005–6016 ms. `numFixes` 0 ó 1. `peorAccuracy` == `accuracy` siempre. |
| 09:09:16 | **Último intento de validación.** El vendedor deja de reintentar. |
| 09:10:13 → 09:12:47 | **Hueco de 2 min 34 s sin ninguna captura.** El GNSS está adquiriendo de forma continua por primera vez. |
| 09:12:47 | Primer fix GNSS real: `accuracy` 40.0439987182617 (**no redondo**). |
| 09:13:17 → 09:14:47 | Curva de adquisición: 116.59 → 12.84 → 10.97 → **7.70**. |
| 09:12:47 – 09:19:43 | 100 % GNSS, `accuracy` entre 6.30 y 25.72 m. |
| 09:18:21 | Tracking: `19.5145359, -96.8802109` (±6.97) → **64.3 m** del cliente 9949. Dentro de los 80 m. |
| 09:18:53 | Tracking: `19.5147362, -96.8804245` (±6.70) → **39.4 m** del cliente 9949. Dentro de los 80 m. |
| 09:18:55 | Validación: `fuera_de_rango`, ±6.75 m, `tiempoMs` **713**, `numFixes` **1**. Posición reportada `19.5144367, -96.8795242` → `distancia` **136.97 m**. Es un salto de ~95 m en **2 segundos** respecto del tracking anterior. |
| 09:18:59 | **Reubicación del cliente 9949** a `19.5144317, -96.879495` (`tempreubicacionesmovil` id 6073, usuario 1024). |
| 09:19:03 | Validación: `ok`, ±6.70 m, `tiempoMs` **700**, `clienteLatitud` **19.5144310**, `distancia` **2.55 m**. |
| 09:19:43 | Tracking: `19.5146523, -96.8801346` (±6.30) → **69.8 m** del cliente 9949 (coordenadas originales). Dentro de los 80 m. |

**Dato 1 — el presupuesto de 6 s no es el problema principal.** Con el GNSS enganchado la validación resolvió en **~0.7 s**. Lo que falló es que el chip nunca se enganchó durante 30 minutos, y se enganchó justo cuando el vendedor **dejó de reintentar**.

**Dato 2 — el `fuera_de_rango` de las 09:18:55 fue un falso negativo.** Los tres fixes de tracking que lo rodean (09:18:21, 09:18:53, 09:19:43), todos con ±6.3–7.0 m, sitúan al vendedor a **64.3 m, 39.4 m y 69.8 m** del cliente 9949: **dentro** de los 80 m permitidos. La validación intercalada entre ellos lo situó a 136.97 m. **El vendedor sí estaba en el cliente; la app le dijo que no, y él movió el pin del cliente para poder trabajar.**

---

## 2. Por qué sucede

### 2.1 Causa raíz A — La petición de 30 s hace *duty-cycling* y mata el arranque en frío

`@c:/xallapan/services/BackgroundLocationService.ts:24` fija `intervalMs = 30000`, y el watch se suscribe con `interval` y `fastestInterval` = 30 000 ms (`@c:/xallapan/services/BackgroundLocationService.ts:63-74`).

Con `PRIORITY_HIGH_ACCURACY` e intervalo de 30 s, Google Play Services **enciende el receptor GNSS un instante alrededor de cada vencimiento y lo apaga en medio**. Un receptor en arranque en frío necesita tiempo *continuo* encendido para decodificar las efemérides (cada subtrama tarda 30 s; el almanaque completo 12.5 min). Con ventanas troceadas de pocos segundos:

- nunca termina de decodificar nada,
- GMS devuelve el *fallback* de red (celda/WiFi) para cumplir el plazo,
- el ciclo se repite indefinidamente.

Eso es exactamente lo que muestran los 30 minutos de `accuracy` 200/300/400: **posiciones de red, no de satélite**. Confirmación adicional: las coordenadas se repiten bit a bit entre capturas separadas por minutos (`19.5166339874268, -96.8798370361328` aparece 20+ veces) — es el mismo centroide de celda, no mediciones nuevas.

**Alcance real, medido en §0.3:** esta configuración **no rompe a toda la flota**. Casi todos los equipos obtienen un fix bueno en su primera captura del día. Lo que hace es dejar **margen cero**: en un equipo débil (Moto E32s / Helio G37) o tras una noche completa bajo techo (§0.3b), el receptor no logra recuperar el enganche. La corrección sigue siendo necesaria — pero como eliminación de fragilidad, no como incendio generalizado.

### 2.2 Causa raíz B — Cada validación destruye la suscripción nativa y reinicia el GNSS

Secuencia actual al terminar una validación, en `aceptar()`:

1. `Geolocation.clearWatch(watchId)` del watch rápido — `@c:/xallapan/services/LocationService.ts:534-537`.
2. `this.restaurarWatchDeFondo()` — `@c:/xallapan/services/LocationService.ts:546`.
3. → `startWatch()` → **`stopWatch()`** — `@c:/xallapan/services/BackgroundLocationService.ts:81-90`.

En el paso 3 quedan **0 suscriptores**, así que el módulo JS llama `stopObserving` → `removeLocationUpdates` → **GMS apaga el motor GNSS**. Inmediatamente después se re-suscribe a 30 s, o sea vuelta al *duty-cycling*.

**Consecuencia perversa: cada reintento del vendedor borra el progreso de adquisición del GNSS.** Es un bucle auto-sostenido: mientras más reintenta, más tiempo permanece roto. Por eso los 17 intentos en 17 minutos no convergieron nunca, y por eso el enganche ocurrió **3 min 31 s después del último intento** (09:09:16 → 09:12:47).

### 2.3 Causa raíz C — El parche de `LocationRequest` deja pasar el fix de red como primer update

`@c:/xallapan/patches/react-native-geolocation-service+5.3.1.patch:24-28` construye la petición sin fijar dos parámetros:

- **`setWaitForAccurateLocation(true)`** — sin él, GMS entrega de inmediato el primer fix grueso de red en lugar de esperar unos instantes al GNSS.
- **`setMaxUpdateAgeMillis(...)`** — el default documentado es `IMPLICIT_MAX_UPDATE_AGE`, que **equivale al `interval`**. Con la petición de fondo a 30 s, GMS puede entregar como primer update una ubicación de hasta **30 s de antigüedad**.

Ese fix grueso queda como `mejor` porque el filtro de warm-up sólo descarta fixes gruesos **si ya existe** un `mejor` (`@c:/xallapan/services/LocationService.ts:621-624`), y en el primer fix `mejor` es `null`. Por eso el valor de red termina reportado como la posición del vendedor.

### 2.4 Causa raíz D — Un fix cacheado aceptado al instante produce falsos `fuera_de_rango` *(severidad máxima)*

Este es el hallazgo nuevo, y es más grave que el bloqueo del vendedor: **corrompe datos maestros de forma permanente.**

**Mecanismo, paso a paso:**

1. `getBestLocation` se suscribe y acto seguido llama `this.forzarIntervaloNativo(opcionesWatch)` (`@c:/xallapan/services/LocationService.ts:667`), que **re-registra la `LocationRequest` nativa**.
2. Al re-registrarse, GMS puede entregar como primer update una **ubicación histórica**, porque el parche no fija `setMaxUpdateAgeMillis` (§2.3).
3. `getBestLocation` corta en el **primer** fix cuyo `accuracy <= PRECISION_OBJETIVO` (15 m) — `@c:/xallapan/services/LocationService.ts:636`. El fix cacheado traía ±6.75 m, así que se aceptó **de inmediato, con `numFixes = 1` y `tiempoMs = 713`**.
4. No existe ninguna verificación de coherencia: ni un segundo fix que confirme, ni comparación contra el último fix del tracking.
5. Ese fix cacheado estaba a **~95 m** de donde el vendedor realmente estaba (tracking 2 s antes, ±6.70 m). Físicamente imposible: 95 m en 2 s = 171 km/h.
6. Distancia calculada sobre la posición equivocada → **136.97 m** → `fuera_de_rango`.

**Un `accuracy` bajo no garantiza que el fix sea reciente.** El código actual trata ±6.75 m como prueba suficiente, y por eso un solo fix rancio basta para producir un veredicto negativo firme.

#### Esto no es un incidente: es sistémico

La consulta T3 devolvió **50+ reubicaciones precedidas de un veredicto negativo en menos de 60 s**, entre el 2026-07-11 y el 2026-07-29, repartidas en **11 vendedores** (1022, 1024, 1025, 1027, 1028, 1029, 1036, 1037, 1041, 1013, 4) y 12 sucursales. El caso base era la punta del iceberg.

La firma del fix cacheado es inequívoca en los datos:

| idReubicacion | usuario | distancia | accuracy | numFixes | tiempoMs |
|---|---|---|---|---|---|
| 5495 | 1041 | **15 425 m** | 11.50 | **1** | **857** |
| 5553 | 1022 | **5 743 m** | 6.00 | **1** | 5 730 |
| 5575 | 1022 | **5 093 m** | 12.99 | **1** | 5 727 |
| 5552 | 1022 | **4 851 m** | 4.90 | **1** | 7 200 |
| 5796 | 1013 | **4 391 m** | 15.67 | **1** | 3 751 |
| 5944 | 1022 | **1 993 m** | 7.80 | **1** | 1 231 |
| 6073 | 1024 | 137 m | 6.75 | **1** | **713** | ← caso base

**Un vendedor no está a 15 km de su cliente y reubica el pin.** Esas distancias son imposibles; el fix venía de otro lugar y otro momento. Y fíjate en el patrón común: `numFixes = 1`, `tiempoMs` de 700–2 000 ms, y `accuracy` **excelente** (3.5 a 12 m). El código aceptaba una lectura instantánea de aspecto impecable y completamente falsa.

El contraste con las lecturas legítimas es limpio:

| idReubicacion | distancia | accuracy | numFixes | tiempoMs | lectura |
|---|---|---|---|---|---|
| 5254 | 211 m | 15.35 | **12** | 12 016 | genuina — la coordenada del cliente estaba mal |
| 5679 | 626 m | 18.50 | **10** | 10 016 | genuina |
| 5188 | 289 m | 13.32 | **7** | 8 121 | genuina |

**`numFixes` es el discriminante, no `accuracy`.** Con ≥ 4 fixes y ≥ 4 s de escucha, la lectura es confiable aunque la precisión sea peor. Con 1 fix instantáneo, no lo es aunque marque ±3.5 m. Eso valida directamente el diseño de las Fases 4.1 y 6.1.

**El defecto es crónico, no una regresión.** 8 de los 50 casos son posteriores al despliegue del 2026-07-26 (≈2.7/día), la misma tasa que en las dos semanas anteriores. La versión actual no lo introdujo ni lo corrigió.

También aparece el caso **5992**: `motivo = sin_senal`, `numFixes = 0`, `distancia = NULL` — y una reubicación **9 s después**. El vendedor reubicó el cliente **sin ninguna medición válida**. Confirma que el flujo de reubicación no exige una validación exitosa previa (Fase 6.1).

### 2.5 Consecuencia — Corrupción permanente del catálogo de clientes

El falso `fuera_de_rango` dejó al vendedor una sola salida: `handleReubicarCliente` (`@c:/xallapan/components/SalesScreen.tsx:1503-1636`) → `ReubicacionService.registrarReubicacion` → `actualizarCoordenadasClienteLocal` (`@c:/xallapan/services/ReubicacionService.ts:201-220`), y en el servidor un `UPDATE` que sobrescribe las coordenadas del catálogo maestro — comprobado por los registros de `cat_clientes_suc_log`.

> **Advertencia sobre el script del repo.** `@c:/xallapan/sql/sp_MovilesReubicacionesJSON.sql` **no es la versión desplegada**: referencia `detalle_reubicaciones` con columna `realizado`, mientras producción usa `tempreubicacionesmovil` con `completado`. No usarlo como fuente de verdad. Hay que obtener el DDL real del procedimiento antes de implementar la Fase 6.5.

A las 09:18:59 el cliente 9949 quedó reubicado sobre la **posición cacheada errónea**, no sobre donde el vendedor estaba. El daño se sincronizó al servidor y se aplicó al catálogo.

**No es un incidente aislado.** `tempreubicacionesmovil` muestra que el usuario 1024 reubicó estos dos clientes **6 veces en 7 semanas** — y aquí sí son 6 eventos distintos, porque las coordenadas y las fechas difieren (ver la advertencia sobre reenvíos en §0.4):

| Fecha | Cliente | Coordenadas nuevas | Desplazamiento vs. la reubicación previa |
|---|---|---|---|
| 2026-06-10 | 9903 | 19.5153359, -96.8798293 | — |
| 2026-06-17 | 9903 | 19.5237378, -96.8947449 | **≈ 1 824 m** |
| 2026-06-19 | 9903 | 19.51537, -96.8797797 | ≈ 1 825 m (regreso) |
| 2026-06-24 | 9949 | 19.5153707, -96.8797964 | ≈ 2 m del **cliente 9903** |
| 2026-06-26 | 9949 | 19.5147233, -96.8808083 | ≈ 128 m (corrección) |
| 2026-07-29 | 9949 | 19.5144317, -96.879495 | ≈ 142 m |

Dos patologías visibles:

- **El 2026-06-17 el cliente 9903 se movió 1.8 km** y dos días después hubo que traerlo de vuelta. Es exactamente el resultado de reubicar con un fix de red: la muestra de §0.3 contiene capturas con `accuracy` **1266.5 m** para este mismo usuario.
- **El 2026-06-24 el cliente 9949 quedó a 2 m del cliente 9903** — le asignaron la posición del otro cliente. Corregido dos días después.

**Tres defectos de control que lo permiten:**

1. **Sin validación de precisión.** La reubicación llama `LocationService.getBestLocation()` sin argumentos y sin mirar `accuracy` ni `numFixes` (`@c:/xallapan/components/SalesScreen.tsx:1530-1536`). Un fix de red de ±1266 m se acepta igual que uno de ±6 m.
2. **El límite "una sola vez" no existe.** `clienteYaReubicado` sólo consulta **el día en curso** (`@c:/xallapan/services/ReubicacionService.ts:90-96`), así que en la práctica es *una vez por día, indefinidamente*. El bit `reubicacion` del usuario se marca en `false` al usarlo (`@c:/xallapan/services/ReubicacionService.ts:63-76`) pero la sincronización lo restaura; los 6 registros lo demuestran.
3. **La pista de auditoría está vacía.** `latitudAnterior` y `longitudAnterior` van **hardcodeados a 0** en el payload (`@c:/xallapan/services/ReubicacionService.ts:282-283`). `actualizarCoordenadasClienteLocal` **sí lee** las coordenadas previas (`coordsAntes`, `@c:/xallapan/services/ReubicacionService.ts:209`) pero sólo las manda a `console.log`, y `ReubicacionSchema` no tiene campos donde guardarlas (`@c:/xallapan/services/RealmSchemas.ts:504-518`). Resultado: es imposible medir cuánto se movió un cliente sin recurrir a `cat_clientes_suc_log`.

---

## 3. Qué NO es el problema (descartado con datos)

- **No es la fórmula de distancia.** Verificadas 4 filas contra Haversine: 229.06 / 128.62 / 255.62 / 142.10 m. Exacta.
- **No son los umbrales.** `PRECISION_ABSURDA = 150`, `PRECISION_MAXIMA_ACEPTABLE = 50`, `BUFFER_MAXIMO = 20` (`@c:/xallapan/services/LocationService.ts:39-48`) rechazaron correctamente lecturas de ±200–400 m. Relajarlos permitiría validar desde 300 m. **No tocar.**
- **No es falta de cobertura.** `conCobertura = 1` en las 17 filas. El motivo `sin_senal` describe "0 callbacks en 6 s", no ausencia de red.
- **No es el presupuesto de 6 s por sí solo.** Con GNSS caliente, la validación resolvió en 700 ms.
- **No es información recuperable.** Los clientes 9949 y 9903 están a ~130 m entre sí; un fix de ±300 m no puede distinguirlos. Esas 17 lecturas tienen valor informativo nulo.
- **No fue un error del vendedor.** Los fixes de tracking lo colocan dentro del radio permitido antes, durante y después del `fuera_de_rango`. Reubicó el cliente porque la app le dio un veredicto falso.

---

## 4. Plan de trabajo

### Fase 0 — Verificaciones (ejecutada)

**0.1 Reubicación del cliente 9949 — CONFIRMADA.** La tabla es `tempreubicacionesmovil` (no `detalle_reubicaciones`). Registro **id 6073**: sucursal 28, `cveCliente` 9949, `latitudNueva` 19.5144317, `longitudNueva` -96.879495, usuario 1024, `fechaRegistro` 2026-07-29 **09:19:33** (`fecha` 15:18:59 en UTC). Cae **4 s después** del `fuera_de_rango` y **4 s antes** del `ok`.

**0.2 Cambio de coordenadas del cliente — CONFIRMADO.** La fila `ok` de 09:19:03 trae `clienteLatitud` **19.5144309997559** / `clienteLongitud` **-96.8794937133789** — exactamente las coordenadas de la reubicación — y `distancia` **2.55 m**. La fila `fuera_de_rango` de 09:18:55 traía las originales (19.5146999359131, -96.8807983398438) con `distancia` 136.97 m. Mismo `metrosPermitidos` (80) en ambas.

**0.3 Alcance en la flota — EJECUTADA.** Mi consulta original no devolvía filas por dos errores: `accuracy = ROUND(accuracy, 0)` nunca es cierto en `FLOAT`, y `HAVING MIN(accuracy) >= 100` exigía que el equipo no tuviera GNSS *en todo el día*. Versiones corregidas: **Q1** y **Q2** en `@c:/xallapan/docs/CONSULTAS_AUDITORIA_GPS.md`.

**El KPI salió contaminado.** Para 1024 el 2026-07-29 dio **553 minutos**, no los ~32 esperados, porque `primera_captura` fue a las **00:00:15** — medianoche. `min_hasta_primer_fix_bueno` medía desde la primera captura del día *calendario*, no desde el inicio de jornada. Q1 ya incluye el filtro `DATEPART(HOUR, fecha) BETWEEN 6 AND 20` que lo corrige.

**Resultado 0.3 — el equipo 1024 es un caso atípico, no la norma.** Esto matiza el diagnóstico de §2.1:

| idUsuario | día | capturas | % gruesas | mejor | min hasta 1er fix bueno |
|---|---|---|---|---|---|
| **1024** | 2026-07-29 | 1392 | **77.5 %** | 5.20 | **553** |
| **1024** | 2026-07-28 | 1520 | **48.5 %** | 4.50 | 0 |
| 1040 | 2026-07-29 | 432 | 21.5 % | 12.96 | 0 |
| 1042 | 2026-07-29 | 535 | 21.3 % | 1.84 | 0 |
| 1034 | 2026-07-29 | 509 | 19.1 % | 2.05 | 0 |
| … resto de la flota | | | 0.2 – 17.6 % | 1.15 – 19.10 | 0 – 7 |

Dos lecturas:

- **Casi toda la flota consigue un fix bueno en su primera captura** (`min = 0`). El equipo 1024 es el único con 48–77 % de capturas gruesas. **La configuración de 30 s no rompe a todos los equipos** — pero deja **margen cero**, y en un equipo débil (Moto E32s / Helio G37) es fatal. §2.1 sigue siendo el mecanismo correcto; lo que hay que corregir es la afirmación de que afecta a toda la flota por igual.
- **El equipo 1024 sí es capaz.** El 07-28 obtuvo ±4.50 m en su primera captura de las 10:38. Se degradó después y no pudo recuperarse en 14 horas. No es hardware muerto: es un receptor que perdió el enganche y no logra recuperarlo con la petición troceada.
- **La calidad del tracking de la flota tampoco está bien.** El 20 % de las capturas de varios vendedores supera los 100 m y el `peor_accuracy` habitual ronda **1 200–1 400 m**. Cualquier reporte de recorrido que no filtre por `accuracy` está promediando basura.

**Resultado 0.3b — hallazgo nuevo: el tracking corre 24/7.**

| idUsuario | día | horas sin un solo fix decente |
|---|---|---|
| 1024 | 2026-07-28 | 19, 20, 21, 22, 23 |
| 1024 | 2026-07-29 | 0, 1, 2, 3, 4, 5, 6, 7, 8 |

**117 capturas por hora, todas a 500 m, durante 14 horas seguidas.** 117/hora = una cada ~30.8 s: es el intervalo de tracking corriendo **toda la noche**, con el teléfono guardado bajo techo. `primera_captura` a las 00:00:1x aparece también en 1025, 1030, 1032 y 1013 (2 965 capturas en un día ≈ 24.7 h), así que no es exclusivo de 1024: **el servicio de ubicación nunca se detiene al cerrar la jornada.**

Tres consecuencias, en orden de importancia:

1. **Explica por qué 1024 no pudo engancharse en la mañana.** El receptor pasó 14 horas bajo techo en modo troceado; las efemérides caducaron y a las 08:40 arrancó en frío absoluto. No fue un arranque en frío de inicio de turno: fue un receptor batallando desde las 19:00 del día anterior.
2. **~1 640 filas de basura por equipo y por noche** (14 h × 117), todas con `accuracy` ≥ 100 m, contaminando la bitácora y los reportes de recorrido.
3. **Consumo de batería nocturno** sin ningún valor de negocio.

**0.4 Auditoría de desplazamientos — EJECUTADA, con dos correcciones a mi consulta y un error de criterio de mi parte.**

Correcciones que tuviste que hacer, ambas válidas y que hay que conservar:

- **`TRY_CAST(... AS FLOAT)`** — `cat_clientes_suc_log.latitud/longitud` no son numéricas, son texto. Además hay valores fuera de rango, de ahí el `CASE` que valida `BETWEEN -90 AND 90` antes de llamar a `geography::Point`.
- **`CAST(... AS VARCHAR)` en el JOIN** — `tempreubicacionesmovil.cveCliente` y `cat_clientes_suc_log.id` no son del mismo tipo.

**Mi error de criterio: `ORDER BY metrosMovido DESC` no sirve como triaje.** Tu verificación del caso 1 lo demuestra — cliente **8898** movido **7 027 m** y el dato *actual* es el **correcto**: era una georreferencia legacy mal capturada. Un desplazamiento grande es tan probable que sea una **corrección legítima** como una corrupción, así que ordenar por metros produce exactamente las 305 filas que no se pueden revisar a mano. **La magnitud no discrimina; el patrón sí.**

Dos defectos más del resultado que hay que arreglar antes de seguir:

- **El JOIN duplica filas.** El cliente 8898 sale **5 veces** con `idReubicacionMovil` 4169, 4791, 2370, 1924 y 5914 — todas del usuario 1022 y todas a las mismas coordenadas. El match por coordenadas redondeadas empareja *todas* las reubicaciones históricas con el mismo cambio de catálogo. Se corrige con `OUTER APPLY ... TOP 1 ORDER BY` proximidad temporal.
- **Pero esas 5 filas son un hallazgo por sí mismas**, y T2 lo confirmó en grande (abajo).

**Resultado T2 — los conteos de `tempreubicacionesmovil` son reenvíos, no intentos.**

| idCliente | reubicaciones_movil | cambios_catalogo | usuarios_distintos |
|---|---|---|---|
| 9122 | **19** | **1** | 1 |
| 9124 | **19** | **1** | 1 |
| 8895 | 18 | 1 | 1 |
| 8902 | 15 | 1 | 1 |
| 9064 | 15 | 1 | 1 |

**19 envíos, 1 cambio de catálogo.** Y el patrón delator: los clientes 9122, 9124, 9064, 8894, 8939 y 8940 comparten **el mismo `primer_cambio` al milisegundo** (`2026-07-27 15:57:12.747`) y conteos casi idénticos. Eso es un **lote que se posteó repetidamente**, no un vendedor reubicando 19 veces.

Dos consecuencias:

- **Falta idempotencia en el envío de reubicaciones.** El registro local no queda marcado como sincronizado, o el servidor no deduplica, así que el mismo lote se reenvía en cada ciclo. `usuarios_distintos = 1` en todas las filas descarta abuso coordinado.
- **La corrupción del catálogo es menor de lo que sugiere el conteo bruto**, porque 19 `UPDATE` al mismo valor producen un solo registro en `cat_clientes_suc_log`. Alivia el tamaño de la remediación — pero no cambia nada del diagnóstico de §2.4.
- **Y hay que reinterpretar el límite "una por día":** no se está consumiendo por abuso. Antes de endurecerlo (6.4) hay que arreglar la idempotencia.

**Triaje automatizado en lugar de revisión manual.** Cuatro consultas, en orden de fuerza probatoria. Ninguna requiere mirar el mapa. **Todas viven en `@c:/xallapan/docs/CONSULTAS_AUDITORIA_GPS.md`.**

**T1 — ping-pong.** El cliente volvió a menos de 30 m de una posición que ya había tenido. Cada fila dice: *el cliente X estuvo en A, se movió a B, y luego volvió a A*. **B era basura.** Es el patrón del cliente 9903 (06-10 → 1.8 km → 06-19 de vuelta). Sin ambigüedad y sin revisión humana.

**T2 — inestabilidad.** Clientes con ≥ 3 cambios de georreferencia o ≥ 3 reubicaciones desde el móvil. Es la que produjo el resultado de arriba.

**T3 — el patrón del caso base.** Reubicación precedida en ≤ 10 min de un veredicto negativo. Identifica **motivo**, no sólo desplazamiento, y resultó ser la consulta decisiva (resultados en §2.4). El caso base sale con `seg_entre_bloqueo_y_reubicacion` ≈ **38** y `numFixes` = **1**. Un `numFixes` de 1 en la fila que precede a una reubicación es, por sí mismo, motivo para desconfiar del dato. **Nota:** si `idCliente` viene `NULL` en las filas de validación, sustituir ese predicado por un match sobre `clienteLatitud`/`clienteLongitud`. Cuidado también con la zona horaria: `r.fecha` está en UTC y `r.fechaRegistro` en hora local — usar **`fechaRegistro`**, que es la que coincide con `b.fecha`.

**T4 — colisión.** La posición nueva cae a menos de 15 m de **otro** cliente. Detecta el caso 9949 → coordenadas de 9903. **Mi primera versión falló** con `'geography::Point' failed because parameter 1 is not allowed to be null`: SQL Server evalúa `geography::Point` en el `JOIN` antes de aplicar los filtros de rango, así que no basta con poner los `BETWEEN` en el `ON`. La versión corregida materializa y limpia en tablas temporales.

**Cómo usar el triaje.** T3 resultó ser la consulta decisiva y ya no hace falta intersectarla con nada: su clasificador (`numFixes` + `tiempoMs` + `distancia`, ver §2.4) separa por sí solo la corrupción de la corrección legítima. Las clases *IMPOSIBLE* y *CACHEADO* son la lista de remediación; la clase *GENUINO* se deja en paz. **T1** aporta confirmación independiente vía ping-pong y **T4** detecta colisiones. Lo que sólo aparezca en 0.4 con muchos metros — como el 8898 — se asume **corrección legítima de datos legacy**.

> **Las consultas ejecutables viven en `@c:/xallapan/docs/CONSULTAS_AUDITORIA_GPS.md`**, incluida la corrección de T4 (fallaba por `NULL` en `geography::Point`) y el clasificador **D1**. Este plan conserva sólo los hallazgos.

**Ojo con la precisión del log:** `cat_clientes_suc_log` guarda sólo 4 decimales (≈11 m de cuantización), así que `metrosMovido` trae ±15 m de ruido. Sirve para detectar movimientos de 100 m o más, no para auditar los finos — y por eso el umbral de T1 está en 30 m y no en 5 m.

**0.5 Medir el alcance de los falsos negativos (§2.4).** Cada fila del resultado es un vendedor al que se le negó la visita mientras un fix de tracking de buena calidad, a segundos de distancia, probaba que **sí** estaba en rango:

```sql
WITH val AS (
    SELECT id, idUsuario, sucursal, idCliente, fecha, latitud, longitud,
           clienteLatitud, clienteLongitud, distancia, accuracy, metrosPermitidos
    FROM [dbo].[BitacoraValidacionUbicacionMovil]
    WHERE motivo = 'fuera_de_rango'
      AND clienteLatitud IS NOT NULL AND latitud IS NOT NULL
      AND fecha >= DATEADD(DAY, -60, GETDATE())
), trk AS (
    SELECT idUsuario, sucursal, fecha, latitud, longitud, accuracy
    FROM [dbo].[BitacoraValidacionUbicacionMovil]
    WHERE motivo LIKE 'recorrido%' AND latitud IS NOT NULL
      AND accuracy <= 30
      AND fecha >= DATEADD(DAY, -60, GETDATE())
)
SELECT v.id, v.idUsuario, v.sucursal, v.idCliente, v.fecha,
       v.distancia AS dist_validacion, v.accuracy AS acc_validacion,
       v.metrosPermitidos,
       t.fecha AS fecha_tracking, t.accuracy AS acc_tracking,
       ABS(DATEDIFF(SECOND, v.fecha, t.fecha)) AS seg_diferencia,
       CAST(geography::Point(v.clienteLatitud, v.clienteLongitud, 4326)
            .STDistance(geography::Point(t.latitud, t.longitud, 4326))
            AS DECIMAL(12,1)) AS dist_tracking_al_cliente,
       CAST(geography::Point(v.latitud, v.longitud, 4326)
            .STDistance(geography::Point(t.latitud, t.longitud, 4326))
            AS DECIMAL(12,1)) AS discrepancia_m
FROM val v
CROSS APPLY (
    SELECT TOP 1 trk.*
    FROM trk
    WHERE trk.idUsuario = v.idUsuario AND trk.sucursal = v.sucursal
      AND ABS(DATEDIFF(SECOND, v.fecha, trk.fecha)) <= 60
    ORDER BY ABS(DATEDIFF(SECOND, v.fecha, trk.fecha))
) t
WHERE geography::Point(v.clienteLatitud, v.clienteLongitud, 4326)
        .STDistance(geography::Point(t.latitud, t.longitud, 4326))
      <= v.metrosPermitidos
ORDER BY discrepancia_m DESC;
```

El caso base debe aparecer con `discrepancia_m` ≈ **95** y `seg_diferencia` = **2**.

**Entregable:** número de falsos negativos en 60 días, lista de clientes con georreferencia corrompida y lista de equipos con inanición de GNSS.

---

### Fase 1 — Mantener el GNSS caliente *(corrección principal)*

**Objetivo:** que el receptor nunca pierda el enganche, para que toda validación resuelva en <1 s como a las 09:19:03.

**1.1** Desacoplar el **intervalo nativo** del **intervalo de escritura en bitácora** en `BackgroundLocationService`:
- Suscribir `watchPosition` con `interval` / `fastestInterval` **bajo** (1000–2000 ms) en lugar de `this.intervalMs`.
- Seguir escribiendo en Realm cada `intervalMs` — el downsampling **ya existe** en `@c:/xallapan/services/BackgroundLocationService.ts:101-103`, no hay riesgo de inflar la bitácora.

**1.2** Modo adaptativo para acotar el consumo de batería:
- **Adquisición** (`accuracy > 30 m` o sin fix reciente): intervalo nativo 1000 ms hasta lograr 2 fixes consecutivos con `accuracy <= 30 m`.
- **Enganchado**: intervalo nativo 5000 ms (suficiente para que GMS no apague el receptor) y escritura cada 30 s.
- Si `accuracy` vuelve a degradarse por encima de 100 m durante 2 minutos → regresar a adquisición.

**1.3** Exponer el estado en la notificación del foreground service: `GPS: enganchado ±7 m` / `GPS: buscando satélites…`. Reutilizar `updateNotificationText` (`@c:/xallapan/services/BackgroundLocationService.ts:168-181`).

**Criterio de aceptación:** en el Moto E32s, `MIN(accuracy)` del día baja de ≥200 m a ≤15 m, y el tiempo hasta el primer fix con `accuracy <= 30 m` tras iniciar ruta es < 3 min (hoy: 32 min).

---

### Fase 2 — No destruir la suscripción nativa en cada validación

**2.1** Reordenar `aceptar()` en `@c:/xallapan/services/LocationService.ts:531-563` para que el contador de suscriptores **nunca llegue a 0**: restaurar el watch de fondo *antes* de liberar el watch rápido.

**2.2** Como `startObserving` no se vuelve a invocar si `updatesEnabled` sigue en `true`, el restore debe forzar explícitamente el intervalo de fondo con `forzarIntervaloNativo` (`@c:/xallapan/services/LocationService.ts:145-154`), igual que hoy se fuerza el rápido.

**2.3** Con la Fase 1 aplicada, `forzarIntervaloNativo` durante la validación se vuelve casi innecesario (el intervalo nativo ya es de 1–5 s). Evaluar eliminar el forzado y quedarse con una única petición nativa estable para todo el ciclo de vida de la app — menos superficie de carrera.

**Criterio de aceptación:** en logcat, cero llamadas a `stopObserving` / `removeLocationUpdates` entre el inicio de ruta y el cierre de ruta.

---

### Fase 3 — Corregir el parche de `react-native-geolocation-service`

**3.1** En `buildLocationRequest` (`@c:/xallapan/patches/react-native-geolocation-service+5.3.1.patch:16-31`) agregar:
- `.setWaitForAccurateLocation(true)` — no entregar el fix grueso de red como primer update.
- `.setMaxUpdateAgeMillis(...)` derivado de `options.getMaximumAge()`, con **0** para los watches (nada de ubicaciones históricas). Mantener el comportamiento actual para `getCurrentPosition` con `maximumAge` explícito.

**3.2** Regenerar el patch con `patch-package` y verificar que `apply-patch.js` lo aplica en el build.

**Criterio de aceptación:** desaparecen las filas con coordenadas idénticas bit a bit en capturas separadas por más de un intervalo, y la consulta 0.5 deja de arrojar filas nuevas.

---

### Fase 4 — Guarda de coherencia contra fixes rancios *(cierra el falso negativo, §2.4)*

Esta fase es independiente de la Fase 3 y no requiere rebuild nativo. Es la defensa en profundidad: **aunque GMS entregue un fix rancio, la app no debe emitir un veredicto negativo firme basada en él.**

**4.1 Nunca decidir con un solo fix.** Hoy `getBestLocation` corta en el primer fix con `accuracy <= PRECISION_OBJETIVO` (`@c:/xallapan/services/LocationService.ts:636`). Añadir la condición de que haya **al menos 2 fixes** y que el segundo esté a menos de ~`3 × accuracy` del primero. Si el segundo fix contradice al primero por más de eso, seguir escuchando hasta agotar el presupuesto y quedarse con el clúster consistente.

**4.2 Descartar por antigüedad.** `position.timestamp` viene en el `GeoPosition` y hoy se ignora por completo. Descartar cualquier fix con `Date.now() - position.timestamp > 3000` antes de contarlo en `lecturasRecibidas`. Este cambio, por sí solo, habría evitado el caso base sin tocar nada nativo.

**4.3 Contrastar con el último fix del tracking.** El servicio de fondo ya tiene el último fix en memoria (`lastFixAt` / `onLocationFix`, `@c:/xallapan/services/BackgroundLocationService.ts:92-128`). Exponerlo y, antes de emitir un `fuera_de_rango`, verificar que la velocidad implicada entre ese fix y el de la validación sea físicamente plausible (< ~40 m/s). En el caso base habría dado 171 km/h → fix rechazado → sin falso negativo → sin reubicación.

**4.4 Nunca convertir un fix incoherente en `fuera_de_rango`.** Si la guarda dispara, el motivo debe ser `precision_baja` (reintentable) y **jamás** `fuera_de_rango`, porque `fuera_de_rango` es lo que empuja al vendedor a reubicar el cliente.

**Criterio de aceptación:** reproducir el caso base con fixes inyectados (uno rancio a 95 m + uno fresco) y comprobar que el veredicto es `precision_baja`, no `fuera_de_rango`.

---

### Fase 5 — Validación honesta y sin callejón sin salida

**5.1 Ventana adaptativa.** Si al agotar los 6 s no hubo ningún fix con `accuracy <= PRECISION_ABSURDA`, extender la escucha hasta ~25 s mostrando progreso (`onProgreso` ya existe y `SalesScreen` ya pinta `±N m`, `@c:/xallapan/components/SalesScreen.tsx:1073`) en lugar de fallar. Cortar en cuanto `accuracy <= 15 m` (ya implementado, `@c:/xallapan/services/LocationService.ts:636`). **Sin relajar ningún umbral.**

**5.2 Pre-calentamiento.** Arrancar la escucha rápida al **abrir** la pantalla del cliente / lista de cercanos, no al presionar el botón. Cuando el vendedor pulse "Iniciar visita" el fix ya estará listo.

**5.3 Mensajes reales.** Reemplazar los textos de `sin_senal` y `precision_baja` (`@c:/xallapan/services/LocationService.ts:842-855`) por diagnóstico accionable, distinguiendo:
- 0 fixes en la ventana → "El GPS aún no engancha satélites (N s buscando). Sal a cielo abierto y espera."
- fix de red (`accuracy >= 100` y redondo) → "El teléfono está usando ubicación por antena, no por satélite. Revisa Ajustes > Ubicación."
- No sugerir "inténtalo de nuevo" cuando reintentar empeora el problema.

**5.4 Nuevo motivo de bitácora `red_no_gnss`** para separar "el GPS está impreciso" de "el GPS no existe". Requiere migración de esquema Realm (siguiente versión después de la 48, `@c:/xallapan/services/FullSyncService.ts:28`).

---

### Fase 6 — Blindar la reubicación *(los 3 defectos confirmados en §2.5)*

**6.1 Exigir calidad mínima del fix.** En `@c:/xallapan/components/SalesScreen.tsx:1526-1547`, llamar `getBestLocation` con un presupuesto amplio y **rechazar** si `accuracy > 25 m` o `numFixes < 3`. Hoy no se mira ninguno de los dos. Con esto, la reubicación de 1.8 km del 2026-06-17 habría sido imposible.

**6.2 Persistir las coordenadas anteriores.** Agregar `latitudAnterior`, `longitudAnterior`, `accuracy`, `numFixes` y `metrosMovidos` a `ReubicacionSchema` (`@c:/xallapan/services/RealmSchemas.ts:504-518`). Las coordenadas previas **ya se leen** en `actualizarCoordenadasClienteLocal` (`coordsAntes`, `@c:/xallapan/services/ReubicacionService.ts:209`) — sólo hay que capturarlas antes del `write` y guardarlas.

**6.3 Dejar de enviar ceros.** Sustituir el `latitudAnterior: 0, longitudAnterior: 0` hardcodeado del payload (`@c:/xallapan/services/ReubicacionService.ts:282-283`) por los valores reales, y añadirlos a `getReubicacionesPendientes` (`@c:/xallapan/services/ReubicacionService.ts:240-247`), que hoy no los proyecta.

**6.4 Arreglar el límite "una sola vez".** `clienteYaReubicado` filtra sólo por el día en curso (`@c:/xallapan/services/ReubicacionService.ts:90-96`). Decidir la regla real de negocio (¿una vez por cliente para siempre? ¿una por trimestre?) e implementarla server-side, no en Realm local — el bit `reubicacion` del usuario se restaura en cada sincronización y el límite local es evadible reinstalando la app.

**6.5 Revisión humana por umbral — con matiz.** La idea original era retener toda reubicación de más de ~150 m para aprobación. **El caso 8898 de §0.4 la desaconseja tal cual**: un movimiento de 7 km resultó ser una corrección legítima de datos legacy, y hay 305 cambios en pocos días — un umbral por metros generaría una cola impracticable de trabajo válido. Aplicar la retención sólo cuando **el cliente ya tiene una georreferencia validada** (no `0,0`, no legacy sin verificar) **y** el desplazamiento supera el umbral. Requiere 6.3 para calcular el desplazamiento server-side, y el DDL real del procedimiento (ver advertencia en §2.5).

**6.6 Arreglar la idempotencia del envío de reubicaciones.** T2 lo comprobó: el cliente 9122 tiene **19 filas en `tempreubicacionesmovil` y 1 solo cambio de catálogo**, y lotes enteros comparten el `fechalog` al milisegundo (§0.4). El mismo lote se está posteando en cada ciclo de sincronización. Revisar que `registrarReubicacion` marque el registro como sincronizado tras un `2xx` y que `getReubicacionesPendientes` (`@c:/xallapan/services/ReubicacionService.ts:240-247`) deje de proyectarlo. Idealmente añadir también una clave de idempotencia server-side. **Bloquea 6.4:** el límite "una por día" no se está consumiendo por abuso, así que endurecerlo antes de esto bloquearía trabajo legítimo.

**6.7 Remediar los datos ya corrompidos.** Trabajar sobre las clases *IMPOSIBLE* y *CACHEADO* del clasificador **D1** (`@c:/xallapan/docs/CONSULTAS_AUDITORIA_GPS.md`), **no** sobre el listado ordenado por metros. Casos confirmados de partida: **9949** (142 m sobre un fix cacheado), **9903** (ping-pong de 1.8 km), y los siete de §2.4 con `distancia` > 1 km — entre ellos el **15 425 m** del usuario 1041. El **8898** queda fuera: es corrección legítima. Deduplicar con **D2** antes de contar clientes afectados.

---

### Fase 7 — Detener el tracking fuera de la jornada *(APLAZADA)*

**Aplazada por decisión de negocio.** Se documenta el análisis para retomarla después.

**Importante — lo que esta fase NO arregla.** El tracking nocturno **no causó** la imprecisión de 500 m de la noche: eso lo causó el teléfono estar bajo techo, sin vista al cielo. Ningún ajuste de software obtiene GNSS desde el interior de una casa. El servicio sólo *registró* esa imposibilidad 1 640 veces. Las efemérides también habrían caducado con el servicio apagado.

**Lo que sí puede estar aportando — hipótesis con evidencia parcial.** `startObserving` no se vuelve a invocar mientras `updatesEnabled` siga en `true`, así que un servicio que corrió toda la noche mantiene **la misma `LocationRequest` del día anterior**: GMS nunca recibe una petición nueva de alta precisión y nunca dispara la ráfaga de adquisición ni el refresco de asistencia A-GPS que sí ocurre en un registro nuevo. La comparación de los dos días apunta en esa dirección:

| día | estado del servicio | 1ª captura | accuracy |
|---|---|---|---|
| 07-28 | **arranque fresco** a las 10:38 | 10:38:04 | **4.50 m** — inmediato |
| 07-29 | corriendo desde el día anterior | 00:00:15 | 500 m — 33 min para recuperar |

**Confianza: media.** Es n = 2 y está confundido (horas de inicio distintas, condiciones distintas).

**Prueba decisiva y gratuita, sin release:** la próxima vez que un vendedor esté atorado con `accuracy` alta **a cielo abierto**, pedirle **forzar cierre de la app y reabrirla**. Si el fix se recupera en segundos, la hipótesis del registro rancio queda confirmada y la Fase 7 sube de prioridad. Si sigue atorado, el problema es exclusivamente el duty cycling de §2.1 y la Fase 7 sólo aporta ahorro de batería y limpieza de bitácora.

**7.1** Detener el foreground service al cerrar ruta / cerrar sesión. Hoy sigue corriendo: el equipo 1024 capturó sin interrupción de las 19:00 del 07-28 a las 09:00+ del 07-29, y `primera_captura` a las 00:00:1x aparece también en 1025, 1030, 1032 y 1013.

**7.2** Ventana horaria de seguridad (p. ej. 06:00–21:00) como red de contención. **Verificar primero con la consulta N1** que no haya vendedores con actividad nocturna real.

**7.3** Al reanudar por la mañana, forzar un **registro nativo nuevo** (no sólo reanudar el existente) y entrar directo en el modo de adquisición de 1.2. Esto es lo que atacaría la hipótesis de arriba.

**Beneficio comprobado:** ~1 640 filas de basura menos por equipo y por noche, y ahorro de batería nocturna.
**Beneficio hipotético:** arranque limpio del GNSS por la mañana — pendiente de la prueba de campo.

---

### Fase 8 — Checklist de campo para el equipo (paralelo a todo lo anterior)

En el Moto E32(s) del vendedor 1024, verificar y documentar:

- Ajustes > Ubicación > **Servicios de ubicación > Precisión de la ubicación de Google = ON** (sin esto no hay asistencia A-GPS y el arranque en frío se va a decenas de minutos).
- Búsqueda de **redes Wi-Fi** y **Bluetooth** habilitada.
- Permiso de la app: **Permitir todo el tiempo** + **Usar ubicación precisa** (el código ya detecta el caso "aproximada", `@c:/xallapan/services/LocationService.ts:221-238`).
- Batería: Xallapan en **Sin restricciones** y exenta de optimización (ya se solicita en `requestIgnoreBatteryOptimizations`, `@c:/xallapan/services/BackgroundLocationService.ts:322-349`) — confirmar que el vendedor aceptó.
- **Modo de ahorro de batería desactivado** (Moto lo reactiva solo al 15 %).
- Prueba de control: app tipo *GPS Test* a cielo abierto 5 min. Si no usa ningún satélite → problema de firmware/hardware del equipo, no de la app.
- **Prueba de cierre forzado — decide el destino de la Fase 7.** Con el vendedor atorado en `accuracy` alta **a cielo abierto**: forzar cierre de la app, reabrir, y cronometrar cuánto tarda en dar un fix ≤ 30 m. Recuperación en segundos = la hipótesis del registro nativo rancio queda confirmada.
- **Confirmar búsqueda de redes WiFi.** Los 500 m redondos del tracking nocturno indican resolución **sólo por celda**; con WiFi el fix de red ronda 20–40 m. Sin WiFi también se degrada el A-GPS. Medirlo antes con la consulta **N2**.

---

## 5. Orden de ejecución sugerido

El orden cambió respecto de la primera versión del plan: **la corrupción de datos maestros pesa más que el bloqueo del vendedor**, porque sigue ocurriendo hoy y es difícil de revertir.

| Prioridad | Fase | Por qué |
|---|---|---|
| 1 | **Fase 6.1** | Guarda de `accuracy`/`numFixes` en la reubicación. Cambio mínimo y aislado. §2.4 demostró que hay **~2.7 reubicaciones corruptas al día, en 11 vendedores** — esto detiene la sangría hoy. |
| 2 | **Fase 4** | Cierra el falso negativo. JS puro, sin rebuild. El 4.1 (exigir ≥ 2 fixes coherentes) es exactamente el discriminante que los datos validaron. |
| 3 | **Fase 1 + Fase 2** | Elimina la fragilidad del GNSS. Juntas y en el mismo build. |
| 4 | **Fase 3** | Refuerza 4 desde el lado nativo. Requiere rebuild; agrupar con 1+2. |
| 5 | **D1 + D2 + T4 + 0.5** | Dimensiona la remediación con el clasificador, sin revisión manual. Ver `@c:/xallapan/docs/CONSULTAS_AUDITORIA_GPS.md`. |
| 6 | **Fase 6.6** | Idempotencia del envío. **Bloquea 6.4.** |
| 7 | **Fase 6.2, 6.3, 6.5, 6.7** | Auditoría, retención por umbral y remediación de datos. |
| 8 | **Fase 5** | UX y observabilidad. Deja de ser crítica si 1–4 funcionan. |
| 9 | **Fase 8** | En paralelo, no depende de release. Incluye la prueba de campo que decide el destino de la Fase 7. |
| — | **Fase 7** | **Aplazada.** Retomar sólo si la prueba de cierre forzado confirma la hipótesis del registro rancio. |

## 6. Riesgos

- **Batería.** El intervalo nativo bajo mantiene el GNSS encendido (~25–50 mA). Mitigación: modo adaptativo de 1.2 y medición de consumo en una jornada completa antes de desplegar a toda la flota.
- **Rebuild nativo.** La Fase 3 exige recompilar Android; no es un cambio caliente. La Fase 4 está diseñada para no depender de ella.
- **Migración de esquema Realm.** Las Fases 5.4 y 6.2 requieren subir `schemaVersion`; agrupar ambas en una sola migración.
- **Fase 6.1 puede bloquear vendedores legítimos.** Si un equipo nunca alcanza ±25 m, la reubicación queda inaccesible. Es el comportamiento correcto — pero exige que las Fases 1–2 se desplieguen a corto plazo y que la Fase 8 detecte equipos con GNSS averiado. **Mitigación de datos:** §2.4 muestra que las reubicaciones legítimas se hicieron con 7–12 fixes, así que un umbral de `numFixes >= 3` no habría bloqueado ninguna.
- **Fase 6.4 es una decisión de negocio, no técnica**, y **está bloqueada por 6.6**: mientras el mismo lote se reenvíe 19 veces, cualquier límite basado en conteos castigará al vendedor por un bug de sincronización.
- **El script SQL del repo no es el desplegado** (ver §2.5). Cualquier cambio server-side requiere primero extraer el DDL real de producción.
- **La Fase 7 está aplazada y su beneficio principal es hipotético.** No confundir el ahorro de batería (comprobado) con la mejora del arranque GNSS (sin confirmar). La prueba de cierre forzado de la Fase 8 lo resuelve sin escribir código.
- **Riesgo de sesgo en D1.** El clasificador usa `numFixes` y `tiempoMs`, que son datos *reportados por la app*. Si hubiera un bug en el conteo de `numFixes`, el triaje quedaría envenenado. Contrastar una muestra contra los fixes de tracking (consulta 0.5) antes de revertir masivamente.
- **GNSS averiado a nivel hardware.** Ninguna corrección de software lo resuelve. Por eso la Fase 8 corre en paralelo y la 5.3 debe decirlo claramente al vendedor.
