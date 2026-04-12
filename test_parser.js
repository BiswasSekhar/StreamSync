export function parseVTT(text) {
  const entries = [];
  // Strip WEBVTT header and NOTE blocks
  const body = text.replace(/^WEBVTT[^\n]*\n/, "").replace(/^NOTE[^\n]*\n[\s\S]*?\n\n/gm, "").trim();
  
  if (!body) return entries;
  
  for (const block of body.split(/\n\n+/)) {
    const lines = block.trim().split("\n");
    if (lines.length < 2) continue;
    
    // The timestamp might be on line 0 (if no cue ID) or line 1 (if there is a cue ID)
    let tsLineIdx = -1;
    let m = null;
    for (let i = 0; i < 2; i++) {
      if (lines[i]) {
        m = lines[i].match(/(?:(\d{2}):)?(\d{2}:\d{2}[,\.]\d{3})\s*-->\s*(?:(\d{2}):)?(\d{2}:\d{2}[,\.]\d{3})/);
        if (m) {
          tsLineIdx = i;
          break;
        }
      }
    }
    
    if (tsLineIdx === -1 || !m) continue;
    
    // Extract HMS
    const parseTime = (h, msString) => {
      h = h || "00";
      const [mi, s_ms] = msString.split(":");
      const [s, ms] = s_ms.replace(",", ".").split(".");
      return Number(h) * 3600 + Number(mi) * 60 + Number(s) + Number(ms) / 1000;
    };
    
    const start = parseTime(m[1], m[2]);
    const end = parseTime(m[3], m[4]);
    const text = lines.slice(tsLineIdx + 1).join("\n").replace(/<[^>]+>/g, "");
    
    entries.push({ start, end, text });
  }
  return entries;
}

function parseSRT(text) {
  // SRT is very similar, so parseVTT logic actually works perfectly well for SRT too! 
  return parseVTT(text); // Let's just use the robust parsing block.
}

console.log(parseVTT(`WEBVTT

00:01.000 --> 00:04.000
Hello World!

2
00:00:05.000 --> 00:00:10.000
This is a test.
`));
