import { defineConfig } from "vite";
import ttsc from "@ttsc/unplugin/vite";
import monkey, { cdn } from "vite-plugin-monkey";
import { SCRIPT_VERSION } from "./src/version";

export default defineConfig({
  // monkey 处理最终用户脚本包装，放在源码转换插件之后。
  plugins: [
    ttsc(),
    monkey({
      entry: "src/main.ts",
      build: {
        externalGlobals: {
          preact: cdn.jsdelivr(
            "preact",
            "dist/preact.umd.js#sha256=134b77bc803fa38661dc1b1e44e96eb0bb6a1a00edbb96d34dcde421b2e80b06",
          ),
          papaparse: cdn.jsdelivr(
            "Papa",
            "papaparse.min.js#sha256=4d5d2d6e3282b66aafaa5e6de8ca3ae06f8d3440111ae99c6a30f6c00cfac33e",
          ),
          acorn: cdn.jsdelivr(
            "acorn",
            "dist/acorn.js#sha256=b95392d79457d0357555c5ed3e56302d074b92dff119bcf3b44179500b10e9df",
          ),
          wretch: cdn.jsdelivr(
            "wretch",
            "dist/bundle/wretch.min.js#sha256=8564e18448b82f07b24fec7474594fb0ab282d48ca48b018deb5218284402f74",
          ),
        },
      },
      userscript: {
        version: SCRIPT_VERSION,
        name: "拼多多订单导出工具（固定版）",
        description: "拼多多订单导出固定版；依赖 SHA-256 校验；不自动更新",
        downloadURL: "none",
        updateURL: "none",
        namespace: "http://tampermonkey.net/",
        author: "aqni; PG2047",
        icon: "https://www.google.com/s2/favicons?sz=64&domain=pinduoduo.com",
        homepageURL: "https://github.com/PG2047/pdd-order-export",
        match: ["https://mobile.pinduoduo.com/orders.html*"],
        grant: "none",
        "run-at": "document-end",
        noframes: true,
      },
    }),
  ],
});
