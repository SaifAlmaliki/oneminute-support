(function () {
  try {
    var script = document.currentScript;

    if (!script) return;

    var widgetId = script.getAttribute("data-id");

    if (!widgetId) {
      console.error("[OneMinuteSupport] Missing data-id");
      return;
    }

    fetch("https://oneminute-support-ten.vercel.app/api/widget/session", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      credentials: "omit",
      body: JSON.stringify({
        widget_id: widgetId,
      }),
    })
      .then(function (res) {
        if (!res.ok) throw new Error("Session request failed");
        return res.json();
      })
      .then(function (data) {
        if (!data || !data.token) {
          throw new Error("Invalid session response");
        }

        var iframe = document.createElement("iframe");
        iframe.src =
          "https://oneminute-support-ten.vercel.app/embed?token=" + encodeURIComponent(data.token);

        iframe.setAttribute("title", "Support Chat");
        iframe.style.position = "fixed";
        iframe.style.bottom = "20px";
        iframe.style.right = "20px";
        iframe.style.width = "60px";
        iframe.style.height = "60px";
        iframe.style.border = "none";
        iframe.style.zIndex = "999999";
        iframe.style.borderRadius = "30px";
        iframe.style.background = "transparent";
        iframe.style.transition = "all 0.3s ease";
        iframe.allow = "microphone";

        document.body.appendChild(iframe);

        window.addEventListener("message", function (event) {
          if (event.data && event.data.type === "resize") {
            iframe.style.width = event.data.width;
            iframe.style.height = event.data.height;
            iframe.style.borderRadius = event.data.borderRadius || "12px";
            if (event.data.boxShadow) {
              iframe.style.boxShadow = event.data.boxShadow;
            }
          }
        });
      })
      .catch(function (err) {
        console.error("[OneMinuteSupport] Failed to load widget:", err);
      });
  } catch (error) {
    console.error("[OneMinuteSupport] Widget error:", err);
  }
})();
