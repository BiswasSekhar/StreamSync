import fs from "fs";
import { execSync } from "child_process";

fs.writeFileSync("dummy.srt", `1
00:00:01,000 --> 00:00:04,000
Hello World!
`);

const out = execSync("ffmpeg -i dummy.srt -f webvtt - 2>nul").toString();
console.log("VTT OUTPUT:");
console.log(out);
