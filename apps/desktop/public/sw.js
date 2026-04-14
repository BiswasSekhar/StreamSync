// Service Worker to intercept video playback requests and proxy them over WebRTC

const pendingRequests = new Map();

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
  if (event.data.type === 'WEBRTC_CHUNK_RESPONSE') {
    const { reqId, chunk, totalSize, contentType } = event.data;
    const resolver = pendingRequests.get(reqId);
    if (resolver) {
      resolver({ chunk, totalSize, contentType });
      pendingRequests.delete(reqId);
    }
  } else if (event.data.type === 'WEBRTC_CHUNK_ERROR') {
    const resolver = pendingRequests.get(event.data.reqId);
    if (resolver) {
      resolver({ error: true });
      pendingRequests.delete(event.data.reqId);
    }
  }
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  
  if (url.pathname !== '/webrtc-media') {
    return;
  }

  const rangeHeader = event.request.headers.get('Range');
  
  event.respondWith(new Promise(async (resolve) => {
    const allClients = await self.clients.matchAll({ type: 'window' });
    if (!allClients || allClients.length === 0) {
      return resolve(new Response(null, { status: 404 }));
    }

    const reqId = Date.now().toString() + Math.random().toString();
    
    pendingRequests.set(reqId, ({ chunk, totalSize, contentType, error }) => {
      if (error || !chunk) {
        return resolve(new Response(null, { status: 404 }));
      }
      
      const resHeaders = new Headers({
        'Content-Type': contentType || 'video/mp4',
        'Accept-Ranges': 'bytes',
        'Content-Length': chunk.byteLength.toString(),
        'Access-Control-Allow-Origin': '*'
      });

      let status = 200;
      if (rangeHeader && totalSize) {
        status = 206;
        const parts = rangeHeader.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        // If end is missing, compute it from chunk size
        const end = start + chunk.byteLength - 1;
        
        resHeaders.set('Content-Range', `bytes ${start}-${end}/${totalSize}`);
      }
      
      resolve(new Response(chunk, { status, headers: resHeaders }));
    });

    // Ask the main app window to fetch this chunk over WebRTC
    allClients[0].postMessage({
      type: 'WEBRTC_CHUNK_REQUEST',
      reqId,
      range: rangeHeader
    });
  }));
});
