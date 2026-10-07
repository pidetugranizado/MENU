# Sistema de pedidos — Granizados

Tres páginas independientes que comparten los datos en tiempo real a través de una instancia
**propia de PocketBase** (backend en tu VPS). El frontend se publica en **GitHub Pages**.

| Archivo | Para quién | Acceso |
|---|---|---|
| `pedidos.html` | Clientes (diseñado para celular) | Público |
| `admin.html` | Personal: parqueadero, caja, extras, preparación, historial, productos, toppings, acompañantes, promos, costeo, inventario, contabilidad y usuarios | Correo + contraseña, según el rol |
| `parqueadero.html` | Vigilante: solo entradas y salidas de vehículos (no maneja dinero) | Usuario cajero o admin |

`index.html` solo redirige a `pedidos.html` (para que la dirección principal del sitio abra el menú).

**Instalación paso a paso: ver `GUIA_INSTALACION.txt`.** La dirección del backend se configura en
una sola línea: `js/config.js` → `PB_URL`.

## Usuarios y roles

| Rol | Módulos |
|---|---|
| `admin` | Todo el sistema, incluido **👥 Usuarios** |
| `cajero` | Parqueadero, Caja, Extras (vender y ver ventas) y Preparación; también `parqueadero.html` |
| `preparacion` | Solo Preparación |

- El admin crea usuarios, edita correo/nombre, asigna rol, activa/desactiva y cambia contraseñas.
- Los permisos se validan **en el servidor**: cada colección tiene reglas de lectura por rol y las
  escrituras solo pasan por rutas del servidor que revisan el rol. Aunque alguien fuerce una URL o
  use la consola, PocketBase no entrega ni acepta lo que su rol no permite.
- El menú público no recibe costos, recetas ni inventario.
- Siempre debe quedar al menos un admin activo; nadie puede quitarse su propio rol.
- No existe ninguna opción para borrar toda la base de datos, ni para eliminar usuarios (se desactivan).

## Cómo funciona

1. El cliente hace su pedido en **`pedidos.html`**. El servidor vuelve a calcular precios y
   disponibilidad y asigna el número (#1001, #1002…) en una transacción: no se repiten números.
2. El pedido aparece al instante en **Caja**. El cajero lo cobra (efectivo o transferencia) → pasa a
   **Preparación** y se descuenta el inventario → el área de preparación lo marca como preparado.
3. Los cambios de precios, imágenes o disponibilidad que haga el admin llegan solos a `pedidos.html`.

## Tamaños (onzas del vaso)

- Cada producto tiene sus tamaños (por defecto **12 oz, 16 oz y 22 oz**). Puedes renombrarlos, cambiar
  precios, quitar o agregar tamaños (hasta 6) en **Productos → Editar → Tamaños y precios**.
- El cliente ve el producto **sin precio**; al tocarlo elige el tamaño y ahí ve el precio.
- El **costeo es por tamaño**: cada uno tiene su receta, merma, margen y precio (manual o automático).
  Con "Copiar receta de otro tamaño…" copias la receta y solo ajustas cantidades.
- Rentabilidad, historial, caja y preparación muestran el tamaño de cada producto.

## Sonidos

- `sounds/nuevo-pedido.mp3`: suena cuando llega un pedido nuevo a **Caja**.
- `sounds/sonic-ring.mp3` (anillo de Sonic): suena cuando un pedido entra a **Preparación** (al confirmar su pago).

Los navegadores no dejan reproducir audio hasta que tocas la página una vez: al abrir el admin,
haz clic en cualquier parte. Para cambiar un sonido, reemplaza el archivo con el mismo nombre.

## Promociones (admin → 🔥 Promos)

Las promos activas salen **de primeras** en el menú de pedidos con un aviso estilo callejero
(y también en la franja superior). Cada promo tiene texto grande (ej. `2X1`), título, descripción,
etiqueta, color, imagen y, opcionalmente, un producto que se abre con el botón "¡La quiero!".
Para que una promo tenga **precio especial**, crea un producto con ese precio (ej. "Promo 2x1 Fresa")
y vincúlalo a la promo.

## MIX de sabores

En **Productos → Editar → 🌀 MIX de sabores** activa "Se puede pedir MIX". El cliente solo marca
"¿Lo quieres MIX?" en la web (no elige sabores ahí); los sabores los escoge cuando reclama el
granizado. El precio es el del producto elegido. En Preparación sale como **MODO MIX** para que el
personal le pregunte los sabores al entregar.

## Acompañantes (admin → 🍟 Acompañantes)

Papitas, nachos y otros aperitivos con su precio de venta, cantidad/unidad (und, paquete…) y
precio de compra o costo de preparación (opcional). El cliente los agrega desde
el menú o desde el carrito ("¿Le sumas algo pa' picar?"). En Preparación salen en un recuadro
naranja aparte, debajo de los granizados del mismo pedido.

## Extras (admin → 🛍️ Extras) — para el cajero

Productos que **solo se venden en el local** (gaseosas, agua, dulces, snacks…). **Nunca aparecen
en `pedidos.html`**: viven en su propia colección y el portal de clientes no la lee.
- **Vender**: punto de venta táctil. Toca los productos, elige efectivo (con cambio y montos
  rápidos) o transferencia y pulsa **COBRAR**. Cada venta recibe un número `E-1`, `E-2`…
- **Ventas**: ventas de un día, resumen por producto y **Anular** (la venta anulada no suma en
  caja ni en contabilidad).
- **Catálogo**: nombre, categoría, ícono, cantidad/unidad, precio de compra y precio de venta (con su margen bruto).
- Al cobrar se descuentan del inventario las unidades vendidas; al **Anular** vuelven al inventario.

## Contabilidad (admin → 📊 Contabilidad)

Reúne todo el negocio. Un ingreso cuenta en la **fecha en que se pagó**; pedidos sin pagar y
ventas anuladas no suman.
- **Ingresos**: totales por rubro → **Granizados** (un solo rubro: todos los sabores, tamaños y
  toppings), **Acompañantes** y **Extras** (cada producto con su nombre y su total),
  **Parqueadero** y **Otros ingresos**. Debajo, el **historial** de cada movimiento y el botón
  **+ Ingreso manual** (si eliges Acompañantes/Extras y escribes el mismo nombre, se suma a ese producto).
- **Gastos**: registro manual con tipo contable — *Costo de ventas*, *Gasto operacional*,
  *Gasto no operacional* o *Impuestos* — categoría, proveedor y forma de pago. Toca uno para editarlo.
- **Estado de resultados**: mensual y **acumulado del 1 de enero al 31 de diciembre**, en vista
  “Mes y acumulado” o “12 meses”. Utilidad bruta, operacional, antes de impuestos y neta, con márgenes.
  El costo de ventas puede salir de las **compras registradas en Gastos** (recomendado) o del
  **costeo de recetas** de cada venta (en ese caso las compras tipo costo no se restan, para no
  contar dos veces).
- **Exportar a Excel**: archivo `.xlsx` real (sin internet ni complementos) con 4 hojas —
  Estado de resultados (con fórmulas, totales y porcentajes), Ingresos por rubro, Detalle de
  ingresos y Detalle de gastos. Ingresos y Gastos también se exportan por periodo.
- **Gráficas**: ingresos vs. gastos, utilidad por mes, ingresos por rubro, acumulado del año
  (o ventas diarias del mes), ventas por hora y por día de la semana, productos más vendidos y
  gastos por categoría. Cada gráfica tiene “Ver datos en tabla”.

## Pedido realizado

La pantalla de confirmación muestra una cuenta regresiva de **3 minutos** y pide al cliente
tomar captura. Al terminar se borra el pedido del navegador y la página se cierra. Los navegadores
solo dejan cerrar por código las pestañas abiertas por código; si no lo permiten, la página se
reemplaza por una en blanco (sin quedar en el historial), que la deja descargada igual.

## Apertura sin tirones

Mientras la página carga (fuentes, primer dibujo, menú) las animaciones esperan quietas y arrancan
todas juntas cuando está lista (máximo 1,5 s). Las secciones del menú fuera de pantalla no se
dibujan hasta acercarse.

## Parqueadero

- **Admin → 🚗 Parqueadero**: tarifa fija (no por horas), vehículos dentro, botón
  **MARCAR COMO PAGADO** (cuando el cliente paga en caja), recaudo e historial de entradas y salidas.
- **`parqueadero.html`** (vigilante): registra entradas (placa + nombre) y salidas. Al buscar la placa
  muestra 🟢 PAGADO (permite registrar la salida) o 🔴 PENDIENTE DE PAGO (debe pagar antes de salir).
  No tiene funciones para recibir dinero, cambiar la tarifa, borrar pagos ni ver el recaudo.
- `parqueadero.html` pide iniciar sesión con un usuario **cajero** o **admin**. La tarifa solo la
  cambia el admin.

## Costeo (admin → pestaña 💰 Costeo)

Tres tipos de producto, cada uno con su **costo directo** y su **margen bruto**:

| Tipo | Costo directo | Margen bruto |
|---|---|---|
| 🍧 **Granizados** (se elaboran aquí) | suma de los insumos de la receta: ingredientes, vaso, tapa, pitillo y otros | precio de venta − costo directo |
| 🛍️ **Extras** (gaseosas, cervezas, papas de paquete…) | precio de compra unitario | precio de venta − precio de compra |
| 🍟 **Acompañantes** (categoría aparte) | precio de compra o costo de preparación | precio de venta − costo directo |

**Margen bruto % = margen bruto ÷ precio de venta × 100.** Todo se recalcula solo al editar.

- **Resumen**: margen bruto promedio de cada tipo y, con las **ventas reales del mes**, cuánto margen
  dejaron granizados, acompañantes y extras, si ese margen **cubre los gastos generales**
  (cobertura %) y el **punto de equilibrio** (ventas necesarias al mes).
- **Granizados**: cada tamaño con precio, costo directo (ingredientes + empaque), margen bruto y %.
  Toca uno para editar su receta: insumo, cantidad usada, unidad y costo por unidad
  (ej. `$25.000 ÷ 1.000 ml = $25/ml × 50 ml = $1.250`). Merma opcional. Margen deseado → precio
  calculado `costo ÷ (1 − margen)`, automático o manual. Los toppings también tienen su receta.
- **Extras** y **Acompañantes**: tabla editable (cantidad/unidad, precio de compra, precio de venta);
  el margen se recalcula mientras escribes y se guarda al salir del campo.
- **Insumos**: ingredientes, vasos, tapas, pitillos… con su presentación y precio de compra.
  Convierte unidades (kg↔g, L↔ml, lb, oz…). Los de categoría **Empaque** se muestran como empaque.
- **Gastos generales**: arriendo, servicios, nómina y otros gastos operativos con su **valor mensual**.
  **No se suman al costo de ningún producto**: el margen de todo lo vendido, en conjunto, debe cubrirlos.
  (Los antiguos registros de "mano de obra / costos indirectos" aparecen aquí; los que eran por
  unidad o porcentaje piden su valor mensual.)
- El **precio de compra sale del Inventario**: cada compra lo actualiza y se recalculan solos los
  granizados que usan ese insumo (y sus precios automáticos llegan al portal de pedidos).
  Los pedidos ya hechos guardan su propio precio y costo.

## Inventario (admin → 📦 Inventario)

Conectado con Productos, Costeo y Ventas. El stock vive en el mismo registro del insumo, extra o
acompañante (no se duplica nada): el costo que usa el Costeo es el mismo que actualiza cada compra.

- **Existencias**: nombre, categoría, unidad, stock actual, stock mínimo, estado
  (**Disponible / Bajo stock / Agotado / Sin control**), costo de compra actual, último precio de
  compra y proveedor. Filtros por tipo y estado, y valor total del inventario.
  Los **granizados** no tienen stock propio: se muestra cuántos vasos de cada tamaño se pueden
  preparar con el stock de sus ingredientes y cuál ingrediente limita.
- **+ NUEVA COMPRA**: fecha, proveedor y una o varias líneas (producto/insumo, cantidad, unidad,
  precio unitario o total). Al guardar: **stock nuevo = stock anterior + cantidad comprada**, queda el
  último precio pagado y el costo de compra pasa a ser el de esta compra (ej. de $10.000/kg a
  $12.000/kg). Opcionalmente la registra como gasto “Costo de ventas” en Contabilidad. Una compra con
  fecha anterior a la última registrada solo suma stock (no cambia el costo).
- **Ventas**: al **confirmar el pago** de un pedido se descuentan los ingredientes de la receta de cada
  granizado (por tamaño y unidades), los de los toppings elegidos y los acompañantes; al cobrar un
  extra se descuentan sus unidades. **Stock nuevo = stock anterior − cantidad vendida.** Si se deshace
  el pago o se anula la venta, el inventario se devuelve.
- **± Ajuste manual**: entrada (+), salida/merma (−) o conteo físico (=), con motivo.
- **Control de stock** por artículo: “Activar” (con stock inicial) o registrar una compra. Los
  artículos “Sin control” no descuentan nada (útil para lo que no se cuenta, como el agua).
- **Alerta**: cuando un artículo llega a su stock mínimo aparece un aviso y el número en el menú.
- **Compras** e **Historial**: todo movimiento (compras, entradas, salidas por ventas, devoluciones y
  ajustes) con fecha, cantidad, stock anterior → nuevo, precio de compra y proveedor.

## Dónde se guardan los datos

En la **instancia de PocketBase de Granizados** (VPS), independiente de cualquier otro PocketBase:
- Cada colección guarda el documento en el campo `data` (JSON), su versión `rev` y columnas
  indexadas para consultar por fecha (pedidos, ventas, parqueadero, contabilidad e inventario).
- **Tiempo real**: cada pantalla se suscribe solo a lo que muestra y aplica los cambios que llegan
  (no vuelve a descargar todo). Al recuperar la conexión se sincroniza sola.
- **Sin duplicados**: pedidos, cobros, ventas de extras, parqueadero e inventario se hacen en
  transacciones del servidor; los cambios del admin llevan control de versión (si dos personas
  editan lo mismo a la vez, la segunda se reintenta sobre los datos nuevos).
- En el navegador solo quedan la sesión, el carrito del cliente y preferencias de pantalla.
- Copias de seguridad: panel de PocketBase → Settings → Backups (ver la guía).

## Estructura

```
index.html        Redirige a pedidos.html
pedidos.html      Portal de clientes
admin.html        Portal del personal
parqueadero.html  Módulo del vigilante (parqueadero)
css/common.css    Estilos compartidos
js/config.js      Dirección del backend (PB_URL) — único archivo a configurar
js/vendor/        SDK oficial de PocketBase (MIT)
js/store.js       Conexión a PocketBase: lecturas, tiempo real y escrituras
js/auth.js        Inicio de sesión y roles (admin.html y parqueadero.html)
js/core.js        Lógica compartida (precios, formato, recibo)
js/costing.js     Motor de costeo (unidades, recetas, costo directo, margen bruto, gastos generales)
js/stock.js       Motor de inventario (stock, consumo de recetas, movimientos)
js/pedidos.js     Lógica del portal de pedidos
js/admin.js       Lógica del portal administrativo
js/parqueadero.js Lógica del módulo del vigilante
js/extras.js      Extras: punto de venta del cajero, ventas y catálogo
js/inventario.js  Inventario: existencias, compras, ajustes, historial y alertas
js/usuarios.js    Usuarios: crear, editar, roles, activar/desactivar (solo admin)
js/contabilidad.js Contabilidad: ingresos, gastos, estado de resultados y gráficas
js/charts.js      Gráficas SVG (sin librerías)
js/xlsx.js        Generador de archivos Excel .xlsx (sin librerías)
sounds/           Sonidos de pedido nuevo y de preparación
backend/pb_migrations/  Estructura de la base, reglas por rol y usuarios
backend/pb_hooks/       Rutas del servidor (pedidos, cobros, inventario, permisos)
backend/deploy/         Servicio systemd y configuración Nginx/Caddy
GUIA_INSTALACION.txt    Instalación paso a paso (VPS con MobaXterm + GitHub Pages)
```
