/* Local KaTeX renderer. Use data-math for prose; exports remain literal YAML. */
window.MathUI = {
  render(element, tex, display = false) {
    element.dataset.math = tex;
    element.dataset.mathDisplay = String(display);
    try {
      katex.render(tex, element, {
        displayMode: display,
        output: "htmlAndMathml",
        throwOnError: true,
        strict: "error",
        trust: false,
      });
      delete element.dataset.mathError;
    } catch (error) {
      element.textContent = tex;
      element.dataset.mathError = error.message;
      console.error("Math rendering failed", error);
    }
    return element;
  },
  element(tex, display = false) {
    const element = document.createElement(display ? "div" : "span");
    if (display) element.className = "equation";
    return this.render(element, tex, display);
  },
  matrix(rows, digits = 4) {
    return (
      String.raw`\begin{bmatrix}` +
      rows
        .map((row) =>
          row.map((value) => Number(value).toFixed(digits)).join(" & "),
        )
        .join(String.raw` \\ `) +
      String.raw`\end{bmatrix}`
    );
  },
  renderAll(root = document) {
    root
      .querySelectorAll("[data-math]")
      .forEach((element) =>
        this.render(
          element,
          element.dataset.math,
          element.dataset.mathDisplay === "true",
        ),
      );
  },
};
MathUI.renderAll();
