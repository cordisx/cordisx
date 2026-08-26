export function HostSeats() {
  return (
    <section className="pg-stage" aria-label="CordisX Host seats">
      <div className="pg-app-seat" data-cordisx-playground-seat="app"><p className="pg-hint">App content seat</p></div>
      <div className="pg-main-seat" data-cordisx-playground-seat="main"><p className="pg-hint">Main content seat</p></div>
      <div className="pg-session-seat" data-cordisx-playground-seat="session.content"><p className="pg-hint">Session content seat (fixture only)</p></div>
    </section>
  )
}
