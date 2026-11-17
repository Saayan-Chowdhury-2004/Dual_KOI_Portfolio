import { KoiFluidApp } from "./src/koiFluidApp";

const mount = document.getElementById("app") ?? document.body;
const app = new KoiFluidApp(mount);

(window as unknown as { koiFluidApp?: KoiFluidApp }).koiFluidApp = app;
