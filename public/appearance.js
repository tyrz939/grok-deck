/* Runs before CSS. Dark is the default. A stored Light choice is applied with no flash. */
(function () {
  try {
    var mode = localStorage.getItem("gm-appearance");
    if (mode === "light" || mode === "dark") {
      document.documentElement.setAttribute("data-appearance", mode);
      var meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute("content", mode === "light" ? "#ffffff" : "#000000");
    }
  } catch (error) {
    /* Private mode can block storage. The html attribute stays dark. */
  }
})();
