# Apps Android Cariana

Este proyecto genera dos APK separadas:

- `portal-repartidor`: abre el portal del repartidor.
- `portal-preparador`: abre el portal del preparador.

Las apps son WebView nativas apuntando a `https://gestion-devoluciones-pro.onrender.com`.

Para cambiar la tienda o la URL, edita `SHOP_DOMAIN` o `BASE_URL` en:

- `portal-repartidor/src/main/java/com/cariana/portalrepartidor/MainActivity.java`
- `portal-preparador/src/main/java/com/cariana/portalpreparador/MainActivity.java`

Para compilar desde esta carpeta:

```powershell
C:\Users\USER\.gradle\wrapper\dists\gradle-8.12-bin\cetblhg4pflnnks72fxwobvgv\gradle-8.12\bin\gradle.bat assembleDebug
```

Los APK se generan en:

- `portal-repartidor/build/outputs/apk/debug/portal-repartidor-debug.apk`
- `portal-preparador/build/outputs/apk/debug/portal-preparador-debug.apk`
