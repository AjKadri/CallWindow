const menuButton = document.querySelector(".menu-button");
const navigation = document.querySelector(".nav-pill");

if (menuButton && navigation) {
  menuButton.addEventListener("click", () => {
    const open = navigation.classList.toggle("open");
    menuButton.setAttribute("aria-expanded", String(open));
  });
  navigation.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", () => navigation.classList.remove("open"));
  });
}
