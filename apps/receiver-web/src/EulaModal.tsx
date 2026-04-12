import React, { useState, useEffect } from "react";

export function EulaModal() {
  const [accepted, setAccepted] = useState(true);

  useEffect(() => {
    if (localStorage.getItem("streamsync_eula_accepted") !== "true") {
      setAccepted(false);
    }
  }, []);

  if (accepted) return null;

  const handleAccept = () => {
    localStorage.setItem("streamsync_eula_accepted", "true");
    setAccepted(true);
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.85)", backdropFilter: "blur(10px)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "Inter, system-ui, sans-serif" }}>
      <div style={{ width: 600, maxWidth: "90%", maxHeight: "85vh", background: "#0d0d0d", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 16, display: "flex", flexDirection: "column", overflow: "hidden", boxShadow: "0 24px 60px rgba(0,0,0,0.8)" }}>
        
        {/* Header */}
        <div style={{ padding: "20px 24px", borderBottom: "1px solid rgba(255,255,255,0.06)", background: "linear-gradient(to right, rgba(99,102,241,0.1), transparent)" }}>
          <h2 style={{ margin: 0, color: "#f1f5f9", fontSize: 20, fontWeight: 700 }}>StreamSync Legal Agreement</h2>
          <p style={{ margin: "4px 0 0", color: "#94a3b8", fontSize: 13 }}>Please read and accept the terms of use before proceeding.</p>
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflowY: "auto", padding: "24px", color: "#cbd5e1", fontSize: 14, lineHeight: 1.6 }}>
          <p style={{ marginTop: 0 }}><strong>1. Nature of the Software</strong><br/>
          StreamSync is designed solely as a neutral, peer-to-peer technology tool that allows users to stream and synchronize media files privately between their own devices over communication networks.</p>

          <p><strong>2. No Endorsement of Piracy or Illegal Acts</strong><br/>
          The provider and developer of StreamSync absolutely do not endorse, promote, or encourage piracy, copyright infringement, or any illegal activities. StreamSync does not host, index, or provide access to any copyrighted materials or directories.</p>

          <p><strong>3. User Responsibility</strong><br/>
          By using StreamSync, you acknowledge that you are solely responsible for the data you transmit, stream, and share. You agree that you will strictly use this application to stream media for which you have acquired the appropriate legal rights, licenses, or explicit permissions (e.g., copyright-free works, public domain media, or personal recordings).</p>

          <p><strong>4. Disclaimer of Liability</strong><br/>
          The developer provides this software "as is" and without any warranty. As a neutral service provider, the developer shall not be held liable or designated as an accomplice for any copyright infringement, damages, or illegal actions committed by users of the software. You agree to fully indemnify the developer against any claims arising from your use of StreamSync.</p>

          <p><strong>5. Acceptance</strong><br/>
          By clicking "I Accept", you formally agree to these terms, taking full legal and personal accountability for any media broadcasted using this application.</p>
        </div>

        {/* Footer actions */}
        <div style={{ padding: "20px 24px", borderTop: "1px solid rgba(255,255,255,0.06)", display: "flex", justifyContent: "flex-end", gap: 12, background: "rgba(0,0,0,0.2)" }}>
          <button 
            onClick={() => window.close()} 
            style={{ padding: "10px 20px", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "#e2e8f0", borderRadius: 8, cursor: "pointer", fontSize: 14, fontWeight: 500 }}
          >
            Decline & Exit
          </button>
          <button 
            onClick={handleAccept} 
            style={{ padding: "10px 24px", background: "linear-gradient(135deg, #818cf8, #6366f1)", border: "none", color: "white", borderRadius: 8, cursor: "pointer", fontSize: 14, fontWeight: 600, boxShadow: "0 4px 12px rgba(99,102,241,0.3)" }}
          >
            I Accept
          </button>
        </div>
      </div>
    </div>
  );
}
