class ZammathHeader extends HTMLElement {
  connectedCallback() {
    const active = this.getAttribute('active') || '';
    const links = [
      ['home', '/zammath-consulting/', 'Home'],
      ['about-us', '/about-us/', 'About Us'],
      ['our-services', '/our-services/', 'Our Services'],
      ['our-businesses', '/our-businesses/', 'Our Businesses'],
      ['zamac-fuds', '/zamac-fuds/', 'Zamac Füds'],
      ['contact-us', '/contact-us/', 'Contact Us'],
    ];
    this.innerHTML = `<header class="site-header"><div class="header-inner"><a class="wordmark" href="/zammath-consulting/" aria-label="Zammath Consulting home"><span class="wordmark-mark" aria-hidden="true">Z</span><span class="wordmark-name">Zammath Consulting</span></a><button class="menu-toggle" type="button" aria-expanded="false" aria-controls="company-navigation" aria-label="Open navigation">☰</button><nav class="site-nav" id="company-navigation" aria-label="Main navigation">${links.map(([id, href, label]) => `<a href="${href}"${id === active ? ' aria-current="page"' : ''}${id === 'zamac-fuds' ? ' class="nav-cta"' : ''}>${label}</a>`).join('')}</nav></div></header>`;
    const button = this.querySelector('.menu-toggle');
    const nav = this.querySelector('.site-nav');
    button.addEventListener('click', () => {
      const open = nav.classList.toggle('open');
      button.setAttribute('aria-expanded', String(open));
      button.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
    });
    nav.addEventListener('click', (event) => {
      if (event.target.closest('a')) {
        nav.classList.remove('open');
        button.setAttribute('aria-expanded', 'false');
        button.setAttribute('aria-label', 'Open navigation');
      }
    });
  }
}

class ZammathFooter extends HTMLElement {
  connectedCallback() {
    this.innerHTML = `<footer class="site-footer"><div class="wrap"><div class="footer-top"><div class="footer-brand"><a class="wordmark" href="/zammath-consulting/" aria-label="Zammath Consulting home"><span class="wordmark-mark" aria-hidden="true">Z</span><span class="wordmark-name">Zammath Consulting</span></a><p>Parent company of Zamac Füds. Company profile details will be added when approved.</p></div><div class="footer-contact"><h2>Contact details</h2><p>Official email: to be supplied<br>Telephone: to be supplied<br>Office address: to be supplied</p></div><nav class="footer-links" aria-label="Footer navigation"><a href="/about-us/">About Us</a><a href="/our-services/">Our Services</a><a href="/our-businesses/">Our Businesses</a><a href="/zamac-fuds/">Zamac Füds</a><a href="/contact-us/">Contact Us</a></nav></div><div class="footer-bottom">© ${new Date().getFullYear()} Zammath Consulting</div></div></footer>`;
  }
}

if (!customElements.get('zammath-header')) customElements.define('zammath-header', ZammathHeader);
if (!customElements.get('zammath-footer')) customElements.define('zammath-footer', ZammathFooter);

document.querySelectorAll('form[data-company-contact]').forEach((form) => {
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = form.querySelector('[type="submit"]');
    const status = form.querySelector('[role="status"]');
    if (button.disabled) return;
    button.disabled = true;
    status.textContent = 'Sending your enquiry…';
    status.classList.remove('error');
    try {
      const response = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.fromEntries(new FormData(form))),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'We could not send your enquiry. Please try again.');
      form.reset();
      status.textContent = `Enquiry #${result.id} received. Thank you for contacting Zammath Consulting.`;
    } catch (error) {
      status.textContent = error instanceof TypeError ? 'The enquiry service is unavailable. Please try again later.' : error.message;
      status.classList.add('error');
    } finally {
      button.disabled = false;
    }
  });
});
