# Consultas de auditoría — GPS y reubicaciones

Consultas ejecutables para el diagnóstico de `PLAN_GPS_INANICION_GNSS.md`.
Los hallazgos y conclusiones van en el plan; aquí sólo el SQL.

**Contexto de fechas:** la versión actual de la app se desplegó el **2026-07-26**. Las consultas de cambios de catálogo usan ventana de **3 días** para medir sólo el comportamiento de esta versión.

**Convenciones de esta base:**

- `cat_clientes_suc_log.latitud/longitud` y `cat_clientes_suc.latitud/longitud` son **texto**. Siempre `TRY_CAST(... AS FLOAT)`.
- `tempreubicacionesmovil.cveCliente` y `cat_clientes_suc_log.id` **no son del mismo tipo**. Comparar con `CAST(... AS VARCHAR(50))`.
- `tempreubicacionesmovil.fecha` está en **UTC**; `fechaRegistro` en **hora local**. Para cruzar con `BitacoraValidacionUbicacionMovil.fecha` (local), usar `fechaRegistro`.
- `tempreubicacionesmovil.latitudAnterior/longitudAnterior` están **siempre en 0** (hardcodeados en el cliente).
- `geography::Point` **aborta si algún parámetro es NULL** y no se puede confiar en el orden de evaluación de predicados. Usar tablas temporales cuando haya joins espaciales.

---

## T4 — Colisión: la posición nueva cae encima de otro cliente

**Corregida.** La versión anterior fallaba con `'geography::Point' failed because parameter 1 is not allowed to be null` porque SQL Server evalúa `geography::Point` en el `JOIN` antes de aplicar los filtros de rango. La solución es materializar y limpiar en tablas temporales.

```sql
IF OBJECT_ID('tempdb..#reub') IS NOT NULL DROP TABLE #reub;
IF OBJECT_ID('tempdb..#cli')  IS NOT NULL DROP TABLE #cli;

SELECT r.id, r.cveCliente, r.usuario, r.sucursal, r.fechaRegistro,
       TRY_CAST(r.latitudNueva  AS FLOAT) AS lat,
       TRY_CAST(r.longitudNueva AS FLOAT) AS lng
INTO #reub
FROM tempreubicacionesmovil r
WHERE r.fechaRegistro >= DATEADD(DAY, -3, GETDATE());

DELETE FROM #reub
WHERE lat IS NULL OR lng IS NULL
   OR lat NOT BETWEEN -90  AND  90
   OR lng NOT BETWEEN -180 AND 180;

SELECT c.id,
       TRY_CAST(c.latitud  AS FLOAT) AS lat,
       TRY_CAST(c.longitud AS FLOAT) AS lng
INTO #cli
FROM cat_clientes_suc c;

DELETE FROM #cli
WHERE lat IS NULL OR lng IS NULL
   OR lat NOT BETWEEN -90  AND  90
   OR lng NOT BETWEEN -180 AND 180;

SELECT r.id AS idReubicacion, r.cveCliente, r.usuario, r.sucursal, r.fechaRegistro,
       c.id AS cliente_colisionado,
       CAST(geography::Point(r.lat, r.lng, 4326)
            .STDistance(geography::Point(c.lat, c.lng, 4326))
            AS DECIMAL(12,1)) AS metros_de_separacion
FROM #reub r
INNER JOIN #cli c
        ON CAST(c.id AS VARCHAR(50)) <> CAST(r.cveCliente AS VARCHAR(50))
       AND geography::Point(r.lat, r.lng, 4326)
             .STDistance(geography::Point(c.lat, c.lng, 4326)) <= 15
ORDER BY metros_de_separacion;
```

Cada fila = una reubicación que dejó al cliente encima de **otro** cliente. Es el patrón del 9949 sobre las coordenadas del 9903 (2 m de separación).

---

## D1 — Clasificar las reubicaciones disparadas por un veredicto negativo

**La consulta más importante.** Extiende T3 con un clasificador automático, para no revisar 50+ filas a mano. El discriminante sale de los datos de T3: `numFixes = 1` + `tiempoMs` bajo + `accuracy` excelente + `distancia` absurda = **fix cacheado**, no lectura real.

```sql
SELECT r.id AS idReubicacion, r.cveCliente, r.usuario, r.sucursal,
       r.fechaRegistro, r.latitudNueva, r.longitudNueva,
       v.motivo, v.fecha AS fecha_veredicto,
       v.distancia, v.accuracy, v.numFixes, v.tiempoMs, v.metrosPermitidos,
       DATEDIFF(SECOND, v.fecha, r.fechaRegistro) AS seg_entre_bloqueo_y_reubicacion,
       CASE
           WHEN v.distancia > 1000
               THEN '1-IMPOSIBLE: distancia > 1km, fix cacheado seguro'
           WHEN v.numFixes <= 1 AND v.tiempoMs < 2500 AND v.accuracy <= 15
               THEN '2-CACHEADO: 1 fix instantaneo con accuracy buena'
           WHEN v.numFixes <= 1
               THEN '3-SOSPECHOSO: decision con un solo fix'
           WHEN v.numFixes >= 4 AND v.tiempoMs >= 4000
               THEN '5-GENUINO: lectura multi-fix, reubicacion legitima'
           ELSE '4-AMBIGUO: revisar manualmente'
       END AS clasificacion,
       CASE WHEN r.fechaRegistro >= '2026-07-26' THEN 'version actual'
            ELSE 'version anterior' END AS version_app
FROM tempreubicacionesmovil r
CROSS APPLY (
    SELECT TOP 1 b.motivo, b.fecha, b.distancia, b.accuracy,
                 b.numFixes, b.tiempoMs, b.metrosPermitidos
    FROM [dbo].[BitacoraValidacionUbicacionMovil] b
    WHERE b.idUsuario = r.usuario
      AND b.sucursal  = r.sucursal
      AND b.idCliente = r.cveCliente
      AND b.motivo IN ('fuera_de_rango', 'precision_baja', 'sin_senal')
      AND b.fecha <= r.fechaRegistro
      AND DATEDIFF(MINUTE, b.fecha, r.fechaRegistro) BETWEEN 0 AND 10
    ORDER BY b.fecha DESC
) v
ORDER BY clasificacion, v.distancia DESC;
```

**Uso:** las clases `1` y `2` son la lista de remediación — georreferencias movidas por un fix cacheado. La clase `5` se deja en paz. La `3` y `4` van a cola de revisión.

Resumen agregado para dimensionar:

```sql
SELECT CASE WHEN r.fechaRegistro >= '2026-07-26' THEN 'version actual'
            ELSE 'version anterior' END AS version_app,
       CASE
           WHEN v.distancia > 1000 THEN '1-IMPOSIBLE'
           WHEN v.numFixes <= 1 AND v.tiempoMs < 2500 AND v.accuracy <= 15 THEN '2-CACHEADO'
           WHEN v.numFixes <= 1 THEN '3-SOSPECHOSO'
           WHEN v.numFixes >= 4 AND v.tiempoMs >= 4000 THEN '5-GENUINO'
           ELSE '4-AMBIGUO'
       END AS clasificacion,
       COUNT(*) AS casos,
       COUNT(DISTINCT r.usuario)    AS vendedores,
       COUNT(DISTINCT r.cveCliente) AS clientes_afectados
FROM tempreubicacionesmovil r
CROSS APPLY (
    SELECT TOP 1 b.motivo, b.distancia, b.accuracy, b.numFixes, b.tiempoMs
    FROM [dbo].[BitacoraValidacionUbicacionMovil] b
    WHERE b.idUsuario = r.usuario AND b.sucursal = r.sucursal
      AND b.idCliente = r.cveCliente
      AND b.motivo IN ('fuera_de_rango', 'precision_baja', 'sin_senal')
      AND b.fecha <= r.fechaRegistro
      AND DATEDIFF(MINUTE, b.fecha, r.fechaRegistro) BETWEEN 0 AND 10
    ORDER BY b.fecha DESC
) v
GROUP BY CASE WHEN r.fechaRegistro >= '2026-07-26' THEN 'version actual'
              ELSE 'version anterior' END,
         CASE
             WHEN v.distancia > 1000 THEN '1-IMPOSIBLE'
             WHEN v.numFixes <= 1 AND v.tiempoMs < 2500 AND v.accuracy <= 15 THEN '2-CACHEADO'
             WHEN v.numFixes <= 1 THEN '3-SOSPECHOSO'
             WHEN v.numFixes >= 4 AND v.tiempoMs >= 4000 THEN '5-GENUINO'
             ELSE '4-AMBIGUO'
         END
ORDER BY version_app, clasificacion;
```

---

## D2 — Reenvíos duplicados de la misma reubicación

Los conteos de 19, 18, 15 reubicaciones por cliente en T2 **no son 19 intentos del vendedor**. Esta consulta separa reenvío de intento genuino: si las coordenadas son idénticas, es el mismo registro posteado N veces.

```sql
SELECT cveCliente, usuario, sucursal,
       ROUND(TRY_CAST(latitudNueva  AS FLOAT), 6) AS lat,
       ROUND(TRY_CAST(longitudNueva AS FLOAT), 6) AS lng,
       COUNT(*) AS envios,
       MIN(fechaRegistro) AS primer_envio,
       MAX(fechaRegistro) AS ultimo_envio,
       DATEDIFF(MINUTE, MIN(fechaRegistro), MAX(fechaRegistro)) AS minutos_de_reenvio,
       COUNT(DISTINCT CAST(fechaRegistro AS DATE)) AS dias_distintos,
       MIN(id) AS id_min, MAX(id) AS id_max
FROM tempreubicacionesmovil
GROUP BY cveCliente, usuario, sucursal,
         ROUND(TRY_CAST(latitudNueva  AS FLOAT), 6),
         ROUND(TRY_CAST(longitudNueva AS FLOAT), 6)
HAVING COUNT(*) > 1
ORDER BY envios DESC, minutos_de_reenvio;
```

**Interpretación:**

- `minutos_de_reenvio` pequeño y `dias_distintos = 1` → **reenvío por falta de idempotencia**. El vendedor lo hizo una vez.
- `dias_distintos > 1` con coordenadas idénticas → el cambio **no persiste** y el vendedor lo repite día tras día.
- Coordenadas distintas para el mismo cliente → intentos genuinamente diferentes (esos sí cuentan como reubicaciones múltiples).

Y para saber si el servidor las aplicó:

```sql
SELECT r.cveCliente,
       COUNT(*) AS envios_movil,
       COUNT(DISTINCT ROUND(TRY_CAST(r.latitudNueva AS FLOAT), 6)) AS coords_distintas,
       (SELECT COUNT(*) FROM cat_clientes_suc_log l
         WHERE CAST(l.id AS VARCHAR(50)) = CAST(r.cveCliente AS VARCHAR(50))
           AND LTRIM(RTRIM(l.tipocambio)) = 'Dato actual') AS cambios_aplicados
FROM tempreubicacionesmovil r
GROUP BY r.cveCliente
HAVING COUNT(*) >= 3
ORDER BY envios_movil DESC;
```

Si `envios_movil` = 19 y `cambios_aplicados` = 1, el catálogo se actualizó **una vez**: los otros 18 fueron reenvíos redundantes, no corrupción adicional.

---

## F1 — Falsos negativos: bloqueado estando en rango *(PENDIENTE, la más importante por ejecutar)*

Cada fila es un vendedor al que se le negó la visita mientras un fix de tracking **de buena calidad**, a segundos de distancia, probaba que **sí** estaba dentro del radio. Es la medición del daño operativo, y el contraste independiente que valida el clasificador D1.

```sql
WITH val AS (
    SELECT id, idUsuario, sucursal, idCliente, fecha, latitud, longitud,
           clienteLatitud, clienteLongitud, distancia, accuracy, numFixes,
           tiempoMs, metrosPermitidos
    FROM [dbo].[BitacoraValidacionUbicacionMovil]
    WHERE motivo = 'fuera_de_rango'
      AND clienteLatitud IS NOT NULL AND clienteLongitud IS NOT NULL
      AND latitud IS NOT NULL AND longitud IS NOT NULL
      AND fecha >= DATEADD(DAY, -60, GETDATE())
), trk AS (
    SELECT idUsuario, sucursal, fecha, latitud, longitud, accuracy
    FROM [dbo].[BitacoraValidacionUbicacionMovil]
    WHERE motivo LIKE 'recorrido%'
      AND latitud IS NOT NULL AND longitud IS NOT NULL
      AND accuracy <= 30
      AND fecha >= DATEADD(DAY, -60, GETDATE())
)
SELECT v.id, v.idUsuario, v.sucursal, v.idCliente, v.fecha,
       v.distancia AS dist_validacion, v.accuracy AS acc_validacion,
       v.numFixes, v.tiempoMs, v.metrosPermitidos,
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

**Doble propósito:** además de contar falsos negativos, `numFixes` y `tiempoMs` en el resultado permiten verificar que el patrón "1 fix instantáneo" también domina aquí. Si lo hace, el clasificador D1 queda validado contra una fuente independiente (los fixes de tracking) y no sólo contra sí mismo.

---

## T1 — Ping-pong (ventana de 3 días)

El cliente volvió a una posición que ya había tenido → la posición intermedia era falsa.

```sql
WITH act AS (
    SELECT id,
           TRY_CAST(latitud  AS FLOAT) AS lat,
           TRY_CAST(longitud AS FLOAT) AS lng,
           fechalog, idlog,
           ROW_NUMBER() OVER (PARTITION BY id ORDER BY idlog) AS n
    FROM cat_clientes_suc_log
    WHERE LTRIM(RTRIM(tipocambio)) = 'Dato actual'
      AND TRY_CAST(latitud  AS FLOAT) BETWEEN  -90 AND  90
      AND TRY_CAST(longitud AS FLOAT) BETWEEN -180 AND 180
)
SELECT a.id AS idCliente,
       a.n AS paso_ida,     a.fechalog AS fecha_ida,
       b.n AS paso_regreso, b.fechalog AS fecha_regreso,
       b.n - a.n - 1 AS posiciones_intermedias_sospechosas,
       CAST(geography::Point(a.lat, a.lng, 4326)
            .STDistance(geography::Point(b.lat, b.lng, 4326))
            AS DECIMAL(12,1)) AS metros_ida_vs_regreso
FROM act a
INNER JOIN act b
        ON b.id = a.id
       AND b.n > a.n + 1
       AND geography::Point(a.lat, a.lng, 4326)
             .STDistance(geography::Point(b.lat, b.lng, 4326)) <= 30
WHERE b.fechalog >= DATEADD(DAY, -3, GETDATE())
ORDER BY a.id, a.n;
```

Si esta consulta también falla por NULL, materializar `act` en `#act` con el mismo patrón de limpieza de T4.

---

## Q1 — Calidad GNSS por vendedor y día

`accuracy = ROUND(accuracy, 0)` **nunca es cierto** en `FLOAT`, y `HAVING MIN(accuracy) >= 100` exige que el equipo no tenga GNSS en todo el día. Esta versión evita ambos errores.

```sql
SELECT idUsuario, sucursal, CAST(fecha AS DATE) AS dia,
       COUNT(*) AS capturas,
       SUM(CASE WHEN accuracy >= 100 THEN 1 ELSE 0 END) AS capturas_gruesas,
       CAST(100.0 * SUM(CASE WHEN accuracy >= 100 THEN 1 ELSE 0 END)
            / COUNT(*) AS DECIMAL(5,1)) AS pct_gruesas,
       CAST(MIN(accuracy) AS DECIMAL(10,2)) AS mejor_accuracy,
       CAST(MAX(accuracy) AS DECIMAL(10,2)) AS peor_accuracy,
       MIN(fecha) AS primera_captura,
       MIN(CASE WHEN accuracy <= 30 THEN fecha END) AS primer_fix_bueno,
       DATEDIFF(MINUTE, MIN(fecha),
                MIN(CASE WHEN accuracy <= 30 THEN fecha END)) AS min_hasta_primer_fix_bueno
FROM [dbo].[BitacoraValidacionUbicacionMovil]
WHERE motivo LIKE 'recorrido%' AND accuracy IS NOT NULL
  AND fecha >= DATEADD(DAY, -14, GETDATE())
  AND DATEPART(HOUR, fecha) BETWEEN 6 AND 20
GROUP BY idUsuario, sucursal, CAST(fecha AS DATE)
ORDER BY pct_gruesas DESC;
```

**El filtro `DATEPART(HOUR, fecha) BETWEEN 6 AND 20` es obligatorio.** Sin él, `min_hasta_primer_fix_bueno` mide desde la primera captura del día *calendario* — y como el tracking corre de noche, esa captura es a las 00:00:1x. Así salió el valor absurdo de **553 minutos** para el usuario 1024.

---

## Q2 — Ventanas de inanición: horas completas sin un solo fix decente

```sql
SELECT idUsuario, sucursal, CAST(fecha AS DATE) AS dia,
       DATEPART(HOUR, fecha) AS hora, COUNT(*) AS capturas,
       CAST(MIN(accuracy) AS DECIMAL(10,2)) AS mejor_accuracy
FROM [dbo].[BitacoraValidacionUbicacionMovil]
WHERE motivo LIKE 'recorrido%' AND accuracy IS NOT NULL
  AND fecha >= DATEADD(DAY, -14, GETDATE())
GROUP BY idUsuario, sucursal, CAST(fecha AS DATE), DATEPART(HOUR, fecha)
HAVING MIN(accuracy) >= 100
ORDER BY dia DESC, idUsuario, hora;
```

Cada fila es una hora entera en la que el equipo **no consiguió un solo fix mejor que 100 m**. Fue esta consulta la que reveló el tracking nocturno.

---

## N1 — ¿Hay actividad real de noche? (riesgo de la Fase 7)

Antes de imponer una ventana horaria hay que confirmar que nadie trabaja de noche. Esta consulta busca capturas nocturnas **con GPS bueno**, que serían señal de actividad genuina y no de un teléfono olvidado encendido.

```sql
SELECT idUsuario, sucursal, CAST(fecha AS DATE) AS dia,
       DATEPART(HOUR, fecha) AS hora,
       COUNT(*) AS capturas,
       SUM(CASE WHEN accuracy <= 30 THEN 1 ELSE 0 END) AS capturas_buenas,
       CAST(MIN(accuracy) AS DECIMAL(10,2)) AS mejor_accuracy
FROM [dbo].[BitacoraValidacionUbicacionMovil]
WHERE motivo LIKE 'recorrido%' AND accuracy IS NOT NULL
  AND fecha >= DATEADD(DAY, -14, GETDATE())
  AND (DATEPART(HOUR, fecha) >= 21 OR DATEPART(HOUR, fecha) < 6)
GROUP BY idUsuario, sucursal, CAST(fecha AS DATE), DATEPART(HOUR, fecha)
HAVING SUM(CASE WHEN accuracy <= 30 THEN 1 ELSE 0 END) > 0
ORDER BY capturas_buenas DESC;
```

Cero filas → nadie trabaja de noche, la ventana horaria es segura. Filas con `capturas_buenas` alto → investigar antes de cortar.

---

## N2 — ¿El equipo está usando WiFi para el fix de red?

Los 500 m redondos del tracking nocturno apuntan a resolución **sólo por celda**. Un fix de red asistido por WiFi da 20–40 m. Esta consulta clasifica los fixes gruesos por magnitud.

```sql
SELECT idUsuario, sucursal,
       SUM(CASE WHEN accuracy BETWEEN  15 AND  60 THEN 1 ELSE 0 END) AS red_con_wifi_15_60m,
       SUM(CASE WHEN accuracy BETWEEN  61 AND 199 THEN 1 ELSE 0 END) AS mixto_61_199m,
       SUM(CASE WHEN accuracy >= 200               THEN 1 ELSE 0 END) AS solo_celda_200m_mas,
       COUNT(*) AS total
FROM [dbo].[BitacoraValidacionUbicacionMovil]
WHERE motivo LIKE 'recorrido%' AND accuracy IS NOT NULL
  AND fecha >= DATEADD(DAY, -7, GETDATE())
  AND (DATEPART(HOUR, fecha) >= 21 OR DATEPART(HOUR, fecha) < 6)
GROUP BY idUsuario, sucursal
ORDER BY solo_celda_200m_mas DESC;
```

Un equipo con `solo_celda_200m_mas` dominante y `red_con_wifi_15_60m` en cero probablemente tiene **la búsqueda de redes WiFi desactivada** — lo que además degrada el A-GPS y agrava el arranque en frío. Ítem verificable en campo.
