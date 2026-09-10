(() => {
  "use strict";

  const form = document.querySelector("#estimateForm");
  const areaInput = document.querySelector("#area");
  const locationSelect = document.querySelector("#location");
  const addressInput = document.querySelector("#address");
  const useCurrentLocationButton = document.querySelector("#useCurrentLocation");
  const floorsInput = document.querySelector("#floors");
  const floorsOutput = document.querySelector("#floorsOutput");
  const formStatus = document.querySelector("#formStatus");
  const openRequestButton = document.querySelector("#openRequest");
  const requestDialog = document.querySelector("#requestDialog");
  const requestForm = document.querySelector("#requestForm");
  const requestStatus = document.querySelector("#requestStatus");
  const requestFormWrap = document.querySelector("#requestFormWrap");
  const requestSuccess = document.querySelector("#requestSuccess");
  const requestReference = document.querySelector("#requestReference");
  const authDialog = document.querySelector("#authDialog");
  const openAuthButton = document.querySelector("#openAuth");
  const accountActions = document.querySelector("#accountActions");
  const accountName = document.querySelector("#accountName");
  const signOutButton = document.querySelector("#signOut");
  const adminLink = document.querySelector("#adminLink");
  const googleAuthButton = document.querySelector("#googleAuth");
  const githubAuthButton = document.querySelector("#githubAuth");
  const authPhoneInput = document.querySelector("#authPhone");
  const sendPhoneCodeButton = document.querySelector("#sendPhoneCode");
  const phoneCodeRow = document.querySelector("#phoneCodeRow");
  const phoneCodeInput = document.querySelector("#phoneCode");
  const verifyPhoneCodeButton = document.querySelector("#verifyPhoneCode");
  const authStatus = document.querySelector("#authStatus");
  const assistantDialog = document.querySelector("#assistantDialog");
  const openAssistantButton = document.querySelector("#openAssistant");
  const assistantForm = document.querySelector("#assistantForm");
  const assistantInput = document.querySelector("#assistantInput");
  const assistantMessages = document.querySelector("#assistantMessages");
  const assistantStatus = document.querySelector("#assistantStatus");
  const consultationAction = document.querySelector("#consultationAction");
  const consultationMessage = document.querySelector("#consultationMessage");
  const bookingsLogin = document.querySelector("#bookingsLogin");
  const bookingsLocked = document.querySelector("#bookingsLocked");
  const bookingsContent = document.querySelector("#bookingsContent");
  const bookingList = document.querySelector("#bookingList");
  const refreshBookings = document.querySelector("#refreshBookings");
  const assistantServiceAction = document.querySelector("#assistantServiceAction");
  const apartmentSearchForm = document.querySelector("#apartmentSearchForm");
  const apartmentAreaSearch = document.querySelector("#apartmentAreaSearch");
  const apartmentFinishSearch = document.querySelector("#apartmentFinishSearch");
  const publicAreaSuggestions = document.querySelector("#publicAreaSuggestions");
  const publicApartmentList = document.querySelector("#publicApartmentList");
  const loadMoreApartments = document.querySelector("#loadMoreApartments");

  const resultElements = {
    location: document.querySelector("#resultLocation"),
    shellPrice: document.querySelector("#shellPrice"),
    finishedPrice: document.querySelector("#finishedPrice"),
    shellRange: document.querySelector("#shellRange"),
    finishedRange: document.querySelector("#finishedRange"),
    finishLabel: document.querySelector("#finishLabel"),
    shellRate: document.querySelector("#shellRate"),
    finishedRate: document.querySelector("#finishedRate"),
    stoneArea: document.querySelector("#stoneArea"),
    stoneCost: document.querySelector("#stoneCost"),
    note: document.querySelector("#estimateNote"),
    footprint: document.querySelector("#footprintSpec"),
    height: document.querySelector("#heightSpec"),
    facades: document.querySelector("#facadesSpec"),
    caption: document.querySelector("#viewerCaption")
  };

  let pricingConfig = null;
  let currentProject = null;
  let currentEstimate = null;
  let debounceTimer = null;
  let estimateController = null;
  let authConfig = null;
  let currentUser = null;
  let csrfToken = null;
  let apartmentCursor = null;

  function number(value, digits = 0) {
    return new Intl.NumberFormat("ar-JO", {
      maximumFractionDigits: digits,
      minimumFractionDigits: 0
    }).format(value);
  }

  function money(value, currency) {
    return `${number(value)} ${currency}`;
  }

  function setStatus(element, message = "", type = "") {
    element.textContent = message;
    element.classList.toggle("is-error", type === "error");
    element.classList.toggle("is-success", type === "success");
  }

  function normalizeDigits(value) {
    const arabicDigits = "٠١٢٣٤٥٦٧٨٩";
    const persianDigits = "۰۱۲۳۴۵۶۷۸۹";
    return String(value || "")
      .replace(/[٠-٩]/g, (digit) => String(arabicDigits.indexOf(digit)))
      .replace(/[۰-۹]/g, (digit) => String(persianDigits.indexOf(digit)))
      .replace(/[،,\s]/g, "")
      .replace("٫", ".");
  }

  function parseArea() {
    const normalized = normalizeDigits(areaInput.value);
    const value = Number(normalized);
    return Number.isFinite(value) ? value : NaN;
  }

  function validateArea() {
    const area = parseArea();
    let message = "";
    if (!areaInput.value.trim()) message = "أدخل مساحة البناء الإجمالية";
    else if (!Number.isFinite(area) || area < 40 || area > 50000) message = "أدخل مساحة بين 40 و50,000 م²";
    areaInput.setCustomValidity(message);
    return !message;
  }

  async function parseResponse(response) {
    let payload = {};
    try {
      payload = await response.json();
    } catch {
      payload = {};
    }
    if (!response.ok) {
      const error = new Error(payload.error || "تعذر إكمال الطلب");
      error.field = payload.field;
      throw error;
    }
    return payload;
  }

  function populatePricing(config) {
    locationSelect.replaceChildren();
    for (const location of config.locations) {
      const option = document.createElement("option");
      option.value = location.code;
      option.textContent = location.name;
      locationSelect.append(option);
    }
    locationSelect.value = config.locations.some((item) => item.code === "amman")
      ? "amman"
      : config.locations[0]?.code || "";
    locationSelect.setAttribute("aria-busy", "false");

    for (const [level, rate] of Object.entries(config.rates.finishes)) {
      const target = document.querySelector(`#${level}Rate`);
      if (target) target.textContent = `${number(rate)} ${config.currency} / م²`;
    }
  }

  function collectProject() {
    const data = new FormData(form);
    return {
      area: parseArea(),
      location: String(data.get("location") || ""),
      address: String(data.get("address") || "").trim(),
      floors: Number(data.get("floors")),
      finishLevel: String(data.get("finishLevel") || "standard"),
      stoneFacades: Number(data.get("stoneFacades"))
    };
  }

  function pluralFloors(value) {
    if (value === 1) return "طابق واحد";
    if (value === 2) return "طابقان";
    if (value >= 3 && value <= 10) return `${value} طوابق`;
    return `${value} طابقًا`;
  }

  function updateImmediatePreview() {
    const project = collectProject();
    floorsOutput.textContent = pluralFloors(project.floors);
    resultElements.facades.textContent = String(project.stoneFacades);
    if (Number.isFinite(project.area)) {
      resultElements.caption.textContent = `${number(project.area, 1)} م² · ${pluralFloors(project.floors)}`;
      window.InmaaVisualizer?.update(project);
    }
  }

  function renderEstimate(estimate) {
    const { project, totals, ranges, breakdown, dimensions, currency } = estimate;
    currentProject = {
      area: project.area,
      location: project.location,
      address: project.address,
      floors: project.floors,
      finishLevel: project.finishLevel,
      stoneFacades: project.stoneFacades
    };
    currentEstimate = estimate;

    resultElements.location.textContent = `${project.locationName} · ${project.address}`;
    resultElements.shellPrice.textContent = money(totals.shell, currency);
    resultElements.finishedPrice.textContent = money(totals.finished, currency);
    resultElements.shellRange.textContent = `النطاق: ${money(ranges.shell.min, currency)} — ${money(ranges.shell.max, currency)}`;
    resultElements.finishedRange.textContent = `النطاق: ${money(ranges.finished.min, currency)} — ${money(ranges.finished.max, currency)}`;
    resultElements.finishLabel.textContent = `تشطيب ${project.finishLabel}`;
    resultElements.shellRate.textContent = money(breakdown.shellRate, currency);
    resultElements.finishedRate.textContent = money(breakdown.finishedRate, currency);
    resultElements.stoneArea.textContent = `${number(breakdown.estimatedStoneArea)} م²`;
    resultElements.stoneCost.textContent = money(breakdown.stoneCost, currency);
    resultElements.note.textContent = estimate.disclaimer;
    resultElements.footprint.textContent = `${number(dimensions.footprintWidth, 1)} × ${number(dimensions.footprintDepth, 1)} م`;
    resultElements.height.textContent = `${number(dimensions.estimatedHeight, 1)} م`;
    resultElements.facades.textContent = String(project.stoneFacades);
    resultElements.caption.textContent = `${number(project.area, 1)} م² · ${pluralFloors(project.floors)}`;

    resultElements.shellPrice.classList.remove("is-loading");
    resultElements.finishedPrice.classList.remove("is-loading");
    openRequestButton.disabled = false;
    window.InmaaVisualizer?.update({ ...project, dimensions });
  }

  function focusInvalidField(fieldName) {
    if (!fieldName) return;
    const field = form.elements.namedItem(fieldName);
    if (field instanceof RadioNodeList) {
      field[0]?.focus();
    } else {
      field?.focus?.();
    }
  }

  async function requestEstimate({ announce = false } = {}) {
    if (!pricingConfig) return;
    if (!form.checkValidity()) {
      if (announce) form.reportValidity();
      return;
    }

    estimateController?.abort();
    estimateController = new AbortController();
    const submitButton = form.querySelector('button[type="submit"]');
    if (announce) submitButton.disabled = true;
    setStatus(formStatus, "جارٍ حساب التقدير…");

    try {
      const response = await fetch("/api/estimate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(collectProject()),
        signal: estimateController.signal
      });
      const estimate = await parseResponse(response);
      renderEstimate(estimate);
      setStatus(formStatus, "تم تحديث التقدير من الخادم.", "success");
    } catch (error) {
      if (error.name === "AbortError") return;
      setStatus(formStatus, error.message, "error");
      focusInvalidField(error.field);
    } finally {
      if (announce) submitButton.disabled = false;
    }
  }

  function scheduleEstimate() {
    validateArea();
    updateImmediatePreview();
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => requestEstimate(), 320);
  }

  async function initialize() {
    updateImmediatePreview();
    try {
      const response = await fetch("/api/config", { headers: { Accept: "application/json" } });
      pricingConfig = await parseResponse(response);
      populatePricing(pricingConfig);
      await requestEstimate();
    } catch (error) {
      locationSelect.setAttribute("aria-busy", "false");
      setStatus(formStatus, "تعذر تحميل أسعار البناء. أعد المحاولة بعد تشغيل الخادم.", "error");
    }
    initializeAuth();
  }

  function renderSession(user) {
    const signedIn = Boolean(user);
    currentUser = user;
    openAuthButton.hidden = signedIn;
    accountActions.hidden = !signedIn;
    accountName.textContent = user?.name || user?.email || "حسابي";
    adminLink.hidden = user?.role !== "admin";
    consultationMessage.textContent = signedIn
      ? "احسب التقدير أولًا، ثم افتح نموذج الحجز وأضف الموعد الذي يناسبك."
      : "سجّل دخولك أولًا ثم احسب تقدير المشروع لفتح نموذج الحجز.";
    consultationAction.textContent = signedIn ? "افتح نموذج الحجز" : "سجّل الدخول للحجز";
    bookingsLocked.hidden = signedIn;
    bookingsContent.hidden = !signedIn;
    if (signedIn) loadBookings();
  }

  async function initializeAuth() {
    try {
      const response = await fetch("/api/auth/session", { headers: { Accept: "application/json" } });
      const result = await parseResponse(response);
      authConfig = result.providers;
      csrfToken = result.csrfToken;
      renderSession(result.user);
      googleAuthButton.disabled = !authConfig.google;
      githubAuthButton.disabled = !authConfig.github;
      sendPhoneCodeButton.disabled = !authConfig.phone;
      if (!authConfig.google && !authConfig.github && !authConfig.phone) {
        setStatus(authStatus, "ستُفعَّل خيارات الدخول بعد إعداد Google أو خدمة رسائل الهاتف.");
      }
    } catch {
      renderSession(null);
    }
  }

  async function phoneRequest(path, payload) {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken || "" },
      body: JSON.stringify(payload)
    });
    return parseResponse(response);
  }

  async function loadBookings() {
    if (!currentUser) return;
    bookingList.textContent = "جارٍ تحميل حجوزاتك…";
    try {
      const response = await fetch("/api/bookings", { headers: { Accept: "application/json" } });
      const { bookings } = await parseResponse(response);
      bookingList.replaceChildren();
      if (!bookings.length) {
        const empty = document.createElement("p");
        empty.className = "booking-empty";
        empty.textContent = "لا توجد حجوزات بعد. احسب تقدير مشروعك ثم احجز استشارة.";
        bookingList.append(empty);
        return;
      }
      for (const booking of bookings) {
        const item = document.createElement("article");
        item.className = "booking-item";
        const title = document.createElement("strong");
        title.textContent = booking.reference;
        const details = document.createElement("span");
        const when = booking.appointment_at ? new Date(booking.appointment_at).toLocaleString("ar-JO") : "سيُنسّق الموعد معك";
        details.textContent = `${when} · ${booking.status === "pending" ? "قيد المراجعة" : booking.status}`;
        item.append(title, details);
        bookingList.append(item);
      }
    } catch (error) {
      bookingList.textContent = error.message;
    }
  }

  function addAssistantMessage(text, kind) {
    const message = document.createElement("p");
    message.className = `assistant-message ${kind}`;
    message.textContent = text;
    assistantMessages.append(message);
    assistantMessages.scrollTop = assistantMessages.scrollHeight;
  }

  function finishLabel(value) {
    return ({ super: "Super", super_deluxe: "Super Deluxe", vip: "VIP" })[value] || value;
  }

  function renderPublicApartments(items, append = false) {
    if (!append) publicApartmentList.replaceChildren();
    if (!items.length && !append) {
      publicApartmentList.textContent = "لا توجد شقق مطابقة حاليًا.";
      return;
    }
    for (const apartment of items) {
      const card = document.createElement("article");
      card.className = "public-apartment-card";
      const image = document.createElement("img");
      image.src = apartment.images?.[0]?.url || "/assets/inmaa-logo.jpg";
      image.alt = apartment.title;
      const content = document.createElement("div");
      const title = document.createElement("h3");
      title.textContent = apartment.title;
      const details = document.createElement("p");
      details.textContent = `${apartment.area} · ${finishLabel(apartment.finishType)} · ${number(apartment.areaSqm)} م²`;
      const price = document.createElement("strong");
      price.textContent = money(apartment.price, "د.أ");
      content.append(title, details, price);
      card.append(image, content);
      publicApartmentList.append(card);
    }
  }

  async function loadPublicApartments(append = false) {
    const params = new URLSearchParams({ limit: "6" });
    const area = apartmentAreaSearch.value.trim();
    const finish = apartmentFinishSearch.value;
    if (area) params.set("area", area);
    if (finish) params.set("finish", finish);
    if (append && apartmentCursor) params.set("cursor", apartmentCursor);
    try {
      const response = await fetch(`/api/apartments?${params}`);
      const result = await parseResponse(response);
      apartmentCursor = result.nextCursor;
      renderPublicApartments(result.items, append);
      loadMoreApartments.hidden = !apartmentCursor;
    } catch (error) {
      publicApartmentList.textContent = error.message;
    }
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    requestEstimate({ announce: true });
  });

  apartmentSearchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    loadPublicApartments();
  });

  apartmentAreaSearch.addEventListener("input", async () => {
    const query = apartmentAreaSearch.value.trim();
    if (query.length < 2) return;
    try {
      const response = await fetch(`/api/areas?q=${encodeURIComponent(query)}`);
      const { areas } = await parseResponse(response);
      publicAreaSuggestions.replaceChildren();
      for (const area of areas) {
        const option = document.createElement("option");
        option.value = area;
        publicAreaSuggestions.append(option);
      }
    } catch { /* suggestions remain optional */ }
  });
  apartmentFinishSearch.addEventListener("change", () => loadPublicApartments());
  loadMoreApartments.addEventListener("click", () => loadPublicApartments(true));

  areaInput.addEventListener("input", () => {
    const normalized = normalizeDigits(areaInput.value);
    if (normalized !== areaInput.value) areaInput.value = normalized;
    validateArea();
  });
  form.addEventListener("input", scheduleEstimate);
  form.addEventListener("change", scheduleEstimate);

  openRequestButton.addEventListener("click", () => {
    if (!currentEstimate) return;
    if (!currentUser) {
      authDialog.showModal();
      setStatus(authStatus, "سجّل الدخول أولًا لحجز الاستشارة.", "error");
      return;
    }
    requestFormWrap.hidden = false;
    requestSuccess.hidden = true;
    requestReference.textContent = "—";
    setStatus(requestStatus);
    requestDialog.showModal();
    document.querySelector("#appointmentAt")?.focus();
  });

  document.querySelectorAll("[data-close-dialog]").forEach((button) => {
    button.addEventListener("click", () => requestDialog.close());
  });

  requestDialog.addEventListener("click", (event) => {
    if (event.target === requestDialog) requestDialog.close();
  });

  openAuthButton.addEventListener("click", () => {
    setStatus(authStatus);
    authDialog.showModal();
  });

  document.querySelectorAll("[data-close-auth]").forEach((button) => {
    button.addEventListener("click", () => authDialog.close());
  });

  googleAuthButton.addEventListener("click", () => {
    if (!authConfig?.google) return;
    window.location.assign("/api/auth/google/start");
  });

  githubAuthButton.addEventListener("click", () => {
    if (!authConfig?.github) return;
    window.location.assign("/api/auth/github/start");
  });

  sendPhoneCodeButton.addEventListener("click", async () => {
    const phone = authPhoneInput.value.trim();
    sendPhoneCodeButton.disabled = true;
    setStatus(authStatus, "جارٍ إرسال الرمز…");
    try {
      await phoneRequest("/api/auth/phone/start", { phone });
      phoneCodeRow.hidden = false;
      phoneCodeInput.focus();
      setStatus(authStatus, "أرسلنا رمز التحقق إلى هاتفك.", "success");
    } catch (error) {
      setStatus(authStatus, error.message, "error");
      authPhoneInput.focus();
    } finally {
      sendPhoneCodeButton.disabled = !authConfig?.phone;
    }
  });

  verifyPhoneCodeButton.addEventListener("click", async () => {
    verifyPhoneCodeButton.disabled = true;
    setStatus(authStatus, "جارٍ التحقق…");
    try {
      const result = await phoneRequest("/api/auth/phone/verify", {
        phone: authPhoneInput.value.trim(),
        code: phoneCodeInput.value.trim()
      });
      renderSession(result.user);
      authDialog.close();
    } catch (error) {
      setStatus(authStatus, error.message, "error");
      phoneCodeInput.focus();
    } finally {
      verifyPhoneCodeButton.disabled = false;
    }
  });

  signOutButton.addEventListener("click", async () => {
    try {
      await phoneRequest("/api/auth/signout", {});
      renderSession(null);
    } catch (error) {
      setStatus(formStatus, error.message, "error");
    }
  });

  consultationAction.addEventListener("click", () => {
    if (!currentUser) return authDialog.showModal();
    if (!currentEstimate) {
      document.querySelector("#calculator")?.scrollIntoView({ behavior: "smooth" });
      setStatus(formStatus, "احسب التقدير أولًا قبل حجز الاستشارة.", "error");
      return;
    }
    openRequestButton.click();
  });

  bookingsLogin.addEventListener("click", () => authDialog.showModal());
  refreshBookings.addEventListener("click", loadBookings);
  assistantServiceAction.addEventListener("click", () => openAssistantButton.click());

  useCurrentLocationButton.addEventListener("click", () => {
    if (!window.isSecureContext || !navigator.geolocation) {
      setStatus(formStatus, "تحديد الموقع يحتاج اتصال HTTPS ومتصفحًا يدعم الموقع الجغرافي.", "error");
      return;
    }
    useCurrentLocationButton.disabled = true;
    setStatus(formStatus, "جارٍ طلب إذن تحديد الموقع…");
    navigator.geolocation.getCurrentPosition(async ({ coords }) => {
      try {
        const response = await fetch("/api/geocode/reverse", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken || "" },
          body: JSON.stringify({ latitude: coords.latitude, longitude: coords.longitude })
        });
        const result = await parseResponse(response);
        addressInput.value = result.address;
        addressInput.dispatchEvent(new Event("input", { bubbles: true }));
        setStatus(formStatus, "تم تحديث عنوان موقع البناء.", "success");
      } catch (error) {
        setStatus(formStatus, error.message, "error");
      } finally {
        useCurrentLocationButton.disabled = false;
      }
    }, (error) => {
      const message = error.code === error.PERMISSION_DENIED
        ? "لم تسمح بالوصول إلى موقعك. يمكنك كتابة العنوان يدويًا."
        : "تعذر تحديد موقعك الآن. تأكد من اتصالك وحاول مرة أخرى.";
      setStatus(formStatus, message, "error");
      useCurrentLocationButton.disabled = false;
    }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
  });

  openAssistantButton.addEventListener("click", () => {
    setStatus(assistantStatus);
    assistantDialog.showModal();
    assistantInput.focus();
  });

  document.querySelectorAll("[data-close-assistant]").forEach((button) => {
    button.addEventListener("click", () => assistantDialog.close());
  });

  assistantForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const message = assistantInput.value.trim();
    if (!message) return;
    const submitButton = assistantForm.querySelector('button[type="submit"]');
    submitButton.disabled = true;
    addAssistantMessage(message, "user");
    assistantInput.value = "";
    setStatus(assistantStatus, "جارٍ تجهيز الإجابة…");
    try {
      const response = await fetch("/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken || "" },
        body: JSON.stringify({ message, project: currentProject })
      });
      const result = await parseResponse(response);
      addAssistantMessage(result.reply, "assistant");
      setStatus(assistantStatus);
    } catch (error) {
      setStatus(assistantStatus, error.message, "error");
    } finally {
      submitButton.disabled = false;
    }
  });

  requestForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!requestForm.reportValidity() || !currentProject) return;

    const data = new FormData(requestForm);
    const submitButton = requestForm.querySelector('button[type="submit"]');
    submitButton.disabled = true;
    setStatus(requestStatus, "جارٍ حفظ الطلب…");

    try {
      const response = await fetch("/api/quotes", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken || "" },
        body: JSON.stringify({
          project: currentProject,
          appointmentAt: String(data.get("appointmentAt") || "") || null,
          note: String(data.get("note") || "")
        })
      });
      const result = await parseResponse(response);
      requestReference.textContent = result.reference;
      requestFormWrap.hidden = true;
      requestSuccess.hidden = false;
      requestForm.reset();
    } catch (error) {
      setStatus(requestStatus, error.message, "error");
      const field = requestForm.elements.namedItem(error.field);
      field?.focus?.();
    } finally {
      submitButton.disabled = false;
    }
  });

  initialize();
  loadPublicApartments();
})();
