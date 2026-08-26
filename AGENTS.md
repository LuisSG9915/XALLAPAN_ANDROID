# Reglas de trabajo para XALLAPAN_ANDROID

- Si una solicitud es ambigua, preguntar antes de modificar código o tomar decisiones importantes.
- En las sincronizaciones parciales, usar cursores basados en la última sincronización exitosa; no usar fechas históricas de registros repetidos como cursor principal.
- No utilizar endpoints `full` dentro de sincronizaciones parciales, porque pueden generar consumo excesivo de datos.
- Antes de cambiar la lógica de sincronización, revisar la bitácora, comparar las fechas enviadas y confirmar el comportamiento real del endpoint.
- Separar claramente la sincronización full de la parcial y validar que una respuesta vacía no provoque descargas repetidas.
