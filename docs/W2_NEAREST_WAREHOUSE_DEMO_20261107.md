# W2 Nearest Warehouse — DEV demo

- Backend pickup allocation keeps the existing all-parts stock sufficiency, atomic stock reservation, warehouse manager ownership and QR/receipt contracts.
- Among the eligible active warehouses, prefer minimum Haversine straight-line distance (km). Technician position precedence: GPS fix not older than 30 minutes, technician profile coordinates, then service order booking coordinates. Missing/unusable reference or warehouse coordinates falls back to stable warehouse-ID order. Manager manual selection remains scoped to their own eligible warehouses.
- Estimated distance is **not** driving distance or route time. `distanceNotVerified` remains true in the existing allocation response; warehouse demo addresses/coordinates are synthetic approximations, not geocoded or verified customer-facing locations.
- New `warehouses.latitude/longitude` nullable numeric WGS84 columns and pair/range check; no backfill in shared code, no warehouse/stock history rewrite.
- DEV deployment first applies the exact additive `WarehouseNearestGeo1794048000000` through `WAREHOUSE_GEO_DEV_RELEASE=1` before unchanged W3/cash migration gates and before backend container restart. The runner is idempotent and verifies ledger+schema.
- DEV demo-only coordinates can be seeded separately on the known 20 [DEMO HCM] warehouse records; never copy guessed coordinates to production.
