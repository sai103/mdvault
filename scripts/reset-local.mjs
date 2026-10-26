// ローカルの D1・R2 のデータ（.wrangler/state）を消す。この後 db:migrate:local でテーブルを作り直す
import { rmSync } from "node:fs";

rmSync(".wrangler/state", { recursive: true, force: true });
console.log("ローカルのデータを削除しました（.wrangler/state）");
