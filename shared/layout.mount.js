// layout.mount: inject shared layout and head assets into the current page
(function () {
  // ready: run fn when DOM is ready
  function ready(fn) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", fn, { once: true });
    } else {
      fn();
    }
  }
  // toAbsUrl: resolve a URL against a base
  function toAbsUrl(url, base) {
    try {
      return new URL(url, base).toString();
    } catch (e) {
      return url;
    }
  }

  // dedupeAndAppendHeadNodes: append layout head nodes to document head avoiding duplicates
  function dedupeAndAppendHeadNodes(nodes, layoutBaseUrl) {
    const head = document.head || document.getElementsByTagName("head")[0];
    nodes.forEach((node) => {
      const clone = node.cloneNode(true);

      if (clone.tagName === "LINK" && clone.href) {
        clone.href = toAbsUrl(clone.getAttribute("href"), layoutBaseUrl);
        const exists = Array.from(
          document.querySelectorAll('link[rel="stylesheet"]')
        ).some((l) => l.href === clone.href);
        if (exists) return;
      }

      if (clone.tagName === "SCRIPT" && clone.src) {
        clone.src = toAbsUrl(clone.getAttribute("src"), layoutBaseUrl);
        const exists = Array.from(document.scripts).some(
          (s) => s.src === clone.src
        );
        if (exists) return;
        clone.defer = true;
      }

      head.appendChild(clone);
    });
  }

  ready(async function () {
    // Find the currently executing mount script to read its data attributes
    const currentScript =
      document.currentScript ||
      (function () {
        const scripts = document.getElementsByTagName("script");
        return scripts[scripts.length - 1];
      })();

    const layoutSrc =
      (currentScript &&
        currentScript.dataset &&
        currentScript.dataset.layout) ||
      "../shared/layout.html";

    // Capture the page's original content to place inside the layout slot later
    const originalBodyChildren = Array.from(document.body.childNodes).filter(
      (n) => {
        // keep everything except the current mount script tag itself
        return !(n === currentScript);
      }
    );

    let text;
    try {
      const res = await fetch(layoutSrc, { credentials: "same-origin" });
      if (!res.ok) return;
      text = await res.text();
    } catch (e) {
      return; // leave the page as-is on failure
    }

    // Parse the fetched layout HTML into a document
    const parser = new DOMParser();
    const layoutDoc = parser.parseFromString(text, "text/html");
    const layoutBaseUrl = toAbsUrl(layoutSrc, window.location.href);

    // Bring over head assets (stylesheets and scripts), avoiding duplicates
    const headNodes = Array.from(layoutDoc.head.children).filter(
      (n) => n.tagName === "LINK" || n.tagName === "SCRIPT"
    );
    dedupeAndAppendHeadNodes(headNodes, layoutBaseUrl);

    // Prepare the new body from the layout and resolve any relative asset URLs inside it
    const newBody = layoutDoc.body.cloneNode(true);

    newBody.querySelectorAll("[src]").forEach((el) => {
      const val = el.getAttribute("src");
      if (val && !/^https?:/i.test(val)) {
        el.setAttribute("src", toAbsUrl(val, layoutBaseUrl));
      }
    });
    newBody.querySelectorAll("[href]").forEach((el) => {
      const val = el.getAttribute("href");
      if (val && !/^https?:|^#|^mailto:|^tel:/i.test(val)) {
        el.setAttribute("href", toAbsUrl(val, layoutBaseUrl));
      }
    });

    // Inject the layout body into the document
    document.body.replaceWith(newBody);

    // Place the original page content into the layout slot
    const slot = document.querySelector("[data-layout-slot]");
    if (slot) {
      slot.replaceChildren(...originalBodyChildren);
    }

    // ensure layout.js executes by injecting a fresh script tag
    const expectedLayoutJs = toAbsUrl("layout.js", layoutBaseUrl);
    Array.from(document.querySelectorAll("script[src]")).forEach((scr) => {
      const srcAbs = toAbsUrl(scr.getAttribute("src"), layoutBaseUrl);
      if (srcAbs === expectedLayoutJs) {
        try {
          scr.remove();
        } catch (e) {
          /* ignore */
        }
      }
    });

    // avoid double-loading if host already included layout.js
    const alreadyLoaded = Array.from(document.scripts).some(
      (s) => s.src === expectedLayoutJs
    );
    if (!alreadyLoaded) {
      const s = document.createElement("script");
      s.src = expectedLayoutJs;
      // dynamic scripts execute when loaded; mark to avoid future duplicates
      s.setAttribute("data-injected-by", "layout.mount");
      document.body.appendChild(s);
    }

    // execute other layout body script[src] tags by re-injecting them
    try {
      const bodyScripts = Array.from(
        layoutDoc.body.querySelectorAll("script[src]")
      );
      bodyScripts.forEach((scr) => {
        const srcAbs = toAbsUrl(scr.getAttribute("src"), layoutBaseUrl);
        if (!srcAbs || srcAbs === expectedLayoutJs) return; // layout.js handled above
        Array.from(document.querySelectorAll("script[src]")).forEach((s) => {
          const sAbs = toAbsUrl(s.getAttribute("src"), layoutBaseUrl);
          if (sAbs === srcAbs) {
            try {
              s.remove();
            } catch (e) {}
          }
        });
        const fresh = document.createElement("script");
        fresh.src = srcAbs;
        fresh.defer = true;
        fresh.setAttribute("data-injected-by", "layout.mount");
        document.body.appendChild(fresh);
      });
    } catch (e) {}

    // signal completion
    try {
      window.dispatchEvent(new CustomEvent("layout:mounted"));
    } catch (e) {}
  });
})();
