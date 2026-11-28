// NEXORA student authentication.
// Student identity is established by a Supabase Auth session, never by localStorage alone.
const NEXORA_STUDENT_EMAIL_SUFFIX = "@students.pulse.app";

function NEXORAStudentEmail(code) {
  return String(code || "").trim().toLowerCase() + NEXORA_STUDENT_EMAIL_SUFFIX;
}

function NEXORAShowLogin(message = "") {
  document.body.innerHTML = `
    <main style="min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg-primary,#0b0f19);color:var(--text-primary,#f9fafb);padding:20px;font-family:system-ui,sans-serif;">
      <section style="max-width:420px;width:100%;background:var(--bg-card,#1f2937);border:1px solid var(--border-color,#374151);border-radius:16px;padding:28px;">
        <h1 style="text-align:center;margin:0 0 8px;">NEXORA 🎓</h1>
        <p style="color:var(--text-secondary,#9ca3af);text-align:center;margin:0 0 20px;">Sign in with the student code and password given by your teacher.</p>
        <form id="NEXORAStudentLoginForm" style="display:grid;gap:12px;">
          <label for="NEXORAStudentCode">Student code</label>
          <input id="NEXORAStudentCode" autocomplete="username" autocapitalize="characters" required placeholder="e.g. CLASS8-1234" style="width:100%;box-sizing:border-box;padding:12px;border-radius:8px;border:1px solid #475569;background:#0f172a;color:#fff;font-size:1rem;">
          <label for="NEXORAStudentPassword">Student password</label>
          <input id="NEXORAStudentPassword" type="password" autocomplete="current-password" required placeholder="Enter your password" style="width:100%;box-sizing:border-box;padding:12px;border-radius:8px;border:1px solid #475569;background:#0f172a;color:#fff;font-size:1rem;">
          <p id="NEXORAStudentAuthError" role="alert" style="color:#f87171;font-size:.9rem;margin:0;min-height:1.2em;">${message.replace(/[&<>"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch]))}</p>
          <button id="NEXORAStudentLoginButton" type="submit" style="width:100%;padding:12px;border:0;border-radius:8px;background:#6366f1;color:white;font-weight:700;font-size:1rem;cursor:pointer;">Sign in securely</button>
        </form>
        <p style="font-size:.78rem;color:var(--text-secondary,#9ca3af);text-align:center;margin:14px 0 0;">Forgot your password? Ask your teacher to reset your student login.</p>
      </section>
    </main>`;

  document.getElementById("NEXORAStudentLoginForm").addEventListener("submit", NEXORAStudentSignIn);
}

async function NEXORAStudentSignIn(event) {
  event.preventDefault();
  const codeInput = document.getElementById("NEXORAStudentCode");
  const passwordInput = document.getElementById("NEXORAStudentPassword");
  const errorBox = document.getElementById("NEXORAStudentAuthError");
  const button = document.getElementById("NEXORAStudentLoginButton");
  const code = codeInput.value.trim().toUpperCase();
  const password = passwordInput.value;

  if (!code || !password || !supabaseClient) {
    errorBox.textContent = !supabaseClient
      ? "The secure login service is unavailable. Please try again later."
      : "Enter your student code and password.";
    return;
  }

  button.disabled = true;
  button.textContent = "Signing in…";
  errorBox.textContent = "";

  try {
    const { data, error } = await supabaseClient.auth.signInWithPassword({
      email: NEXORAStudentEmail(code),
      password
    });

    if (error || !data?.user) {
      console.warn("NEXORA student authentication was rejected.", error?.status || "");
      errorBox.textContent = error?.message?.toLowerCase().includes("fetch")
        ? "Could not reach the secure login service. Check your internet connection and try again."
        : "Sign-in failed. Check the student code and password, or ask your teacher to reset them.";
      passwordInput.value = "";
      return;
    }

    const { data: profile, error: profileError } = await supabaseClient
      .from("students")
      .select("id,student_name,class_name,student_code,study_hours,attendance_pct,teacher_request,areas_to_improve")
      .eq("auth_user_id", data.user.id)
      .maybeSingle();

    if (profileError) {
      console.error("NEXORA student profile verification failed.", profileError.code || profileError.message);
      await supabaseClient.auth.signOut();
      errorBox.textContent = "Your login was accepted, but your student profile could not be verified. Please contact your teacher.";
      return;
    }

    if (!profile) {
      await supabaseClient.auth.signOut();
      errorBox.textContent = "This login is not linked to an active student record. Please contact your teacher.";
      return;
    }

    if (typeof NEXORAResetSessionDeadline === "function") NEXORAResetSessionDeadline();
    localStorage.setItem("auraway_student_code", profile.student_code);
    localStorage.setItem("auraway_student_profile", JSON.stringify(profile));
    window.location.reload();
  } catch (error) {
    console.error("NEXORA student sign-in request failed.", error?.name || "UnknownError");
    errorBox.textContent = "A connection error interrupted sign-in. Please check your internet and try again.";
    passwordInput.value = "";
  } finally {
    button.disabled = false;
    button.textContent = "Sign in securely";
  }
}

async function NEXORAInitializeStudentAuth() {
  const currentPage = window.location.pathname.split("/").pop() || "index.html";
  if (["teacher.html", "parent.html", "portals.html"].includes(currentPage)) return;

  if (!supabaseClient) {
    NEXORAShowLogin("The secure login service is unavailable. Please try again later.");
    return;
  }

  const { data: sessionData, error: sessionError } = await supabaseClient.auth.getSession();
  const session = sessionData?.session;
  if (sessionError || !session) {
    localStorage.removeItem("auraway_student_code");
    localStorage.removeItem("auraway_student_profile");
    NEXORAShowLogin();
    return;
  }

  const { data: profile, error } = await supabaseClient
    .from("students")
    .select("id,student_name,class_name,student_code,study_hours,attendance_pct,teacher_request,areas_to_improve")
    .eq("auth_user_id", session.user.id)
    .maybeSingle();

  if (error || !profile) {
    await supabaseClient.auth.signOut();
    localStorage.removeItem("auraway_student_code");
    localStorage.removeItem("auraway_student_profile");
    NEXORAShowLogin("This account is not linked to a student record. Ask your teacher for help.");
    return;
  }

  localStorage.setItem("auraway_student_code", profile.student_code);
  localStorage.setItem("auraway_student_profile", JSON.stringify(profile));
  window.NEXORA_CURRENT_STUDENT = profile;
  window.PULSE_CURRENT_STUDENT = profile;
  NEXORAAddStudentAccountControls();
  NEXORAInitSiblingLinkForm();
  NEXORALoadSiblingAccounts();
  window.dispatchEvent(new CustomEvent("NEXORAStudentReady", { detail: { profile } }));
  window.dispatchEvent(new CustomEvent("pulseStudentReady", { detail: { profile } }));
}

function NEXORAAddStudentAccountControls() {
  const header = document.querySelector(".header-bar");
  if (!header || document.getElementById("NEXORAStudentAccountControls")) return;
  const wrap = document.createElement("div");
  wrap.id = "NEXORAStudentAccountControls";
  wrap.style.cssText = "display:flex;align-items:center;gap:8px;flex-wrap:wrap;";
  const siblingsButton = document.createElement("button");
  siblingsButton.type = "button";
  siblingsButton.className = "btn";
  siblingsButton.textContent = "My Siblings";
  siblingsButton.addEventListener("click", () => document.getElementById("NEXORASiblingAccounts")?.scrollIntoView({ behavior: "smooth", block: "center" }));
  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn";
  button.textContent = "Sign out";
  button.addEventListener("click", studentLogout);
  wrap.append(siblingsButton, button);
  header.appendChild(wrap);
}


async function NEXORALoadSiblingAccounts() {
  const section = document.getElementById("NEXORASiblingAccounts");
  if (!section || !supabaseClient) return;
  const list = section.querySelector("[data-sibling-list]");
  if (!list) return;
  list.textContent = "Loading linked accounts…";
  const { data, error } = await supabaseClient.rpc("pulse_get_my_siblings");
  if (error) { list.textContent = "Sibling accounts are temporarily unavailable."; return; }
  if (!data?.length) {
    list.textContent = "No sibling accounts linked yet. Use the form above to add one.";
    return;
  }
  list.replaceChildren();
  data.forEach(sibling => {
    const card = document.createElement("article");
    card.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:12px;border:1px solid var(--border-color);border-radius:12px;background:var(--bg-card);";
    const info = document.createElement("div");
    const name = document.createElement("strong");
    const klass = document.createElement("p");
    name.textContent = sibling.student_name || "Student";
    klass.textContent = sibling.class_name || "Class not set";
    klass.style.cssText = "margin:4px 0 0;color:var(--text-secondary);font-size:.85rem;";
    info.append(name, klass);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn";
    button.textContent = "Switch account";
    button.addEventListener("click", () => NEXORAOpenSiblingSwitch(sibling));
    card.append(info, button);
    list.append(card);
  });
}

async function NEXORAFinishSiblingAuthentication(code, password, targetId, requestId, panel) {
  const message = panel.querySelector("[data-switch-message]");
  const submit = panel.querySelector('button[type="submit"]');
  const { data: signedIn, error: signInError } = await supabaseClient.auth.signInWithPassword({
    email: NEXORAStudentEmail(code),
    password
  });
  if (signInError || !signedIn?.user) {
    message.textContent = "Sign-in failed. Check the student code and password.";
    panel.elements.password.value = "";
    submit.disabled = false;
    return;
  }
  if (requestId) {
    const { error: approvalError } = await supabaseClient.rpc("pulse_approve_sibling_link_request", {
      p_request_id: requestId
    });
    if (approvalError) {
      await supabaseClient.auth.signOut();
      localStorage.removeItem("auraway_student_code");
      localStorage.removeItem("auraway_student_profile");
      NEXORAShowLogin("Sibling verification could not be completed. Please sign in again.");
      return;
    }
  }
  const { data: profile, error: profileError } = await supabaseClient
    .from("students")
    .select("id,student_name,class_name,student_code,study_hours,attendance_pct,teacher_request,areas_to_improve")
    .eq("auth_user_id", signedIn.user.id)
    .maybeSingle();
  if (profileError || !profile || (targetId && Number(profile.id) !== Number(targetId))) {
    await supabaseClient.auth.signOut();
    localStorage.removeItem("auraway_student_code");
    localStorage.removeItem("auraway_student_profile");
    NEXORAShowLogin("The account could not be verified. Please sign in again.");
    return;
  }
  if (typeof NEXORAResetSessionDeadline === "function") NEXORAResetSessionDeadline();
  localStorage.setItem("auraway_student_code", profile.student_code);
  localStorage.setItem("auraway_student_profile", JSON.stringify(profile));
  window.location.reload();
}

function NEXORAInitSiblingLinkForm() {
  const section = document.getElementById("NEXORASiblingAccounts");
  const panel = section?.querySelector("[data-sibling-link-form]");
  if (!panel || panel.dataset.bound === "true") return;
  panel.dataset.bound = "true";
  panel.addEventListener("submit", async event => {
    event.preventDefault();
    const code = String(panel.elements.code.value || "").trim().toUpperCase();
    const password = panel.elements.password.value;
    const message = panel.querySelector("[data-switch-message]");
    const submit = panel.querySelector('button[type="submit"]');
    if (!code || !password) return;
    submit.disabled = true;
    message.textContent = "Verifying the sibling account…";
    const { data: requestId, error: requestError } = await supabaseClient.rpc("pulse_request_sibling_link", {
      p_sibling_code: code
    });
    if (requestError || !requestId) {
      message.textContent = requestError?.message?.includes("already linked")
        ? "These accounts are already linked. Use Switch account below."
        : "Could not start verification. Check the sibling code and try again.";
      submit.disabled = false;
      return;
    }
    await NEXORAFinishSiblingAuthentication(code, password, null, requestId, panel);
  });
}

function NEXORAOpenSiblingSwitch(sibling) {
  const section = document.getElementById("NEXORASiblingAccounts");
  if (!section) return;
  let panel = section.querySelector("[data-sibling-switch]");
  if (!panel) {
    panel = document.createElement("form");
    panel.dataset.siblingSwitch = "true";
    panel.style.cssText = "display:grid;gap:10px;margin-top:14px;padding:14px;border:1px solid var(--border-color);border-radius:12px;";
    panel.innerHTML = '<strong></strong><label>Sibling student code<input name="code" required autocomplete="username" style="display:block;width:100%;box-sizing:border-box;padding:10px;margin-top:5px;border-radius:8px;border:1px solid var(--border-color);background:var(--bg-primary);color:var(--text-primary);"></label><label>Sibling password<input name="password" type="password" required autocomplete="current-password" style="display:block;width:100%;box-sizing:border-box;padding:10px;margin-top:5px;border-radius:8px;border:1px solid var(--border-color);background:var(--bg-primary);color:var(--text-primary);"></label><p data-switch-message role="status" style="margin:0;color:var(--text-secondary);font-size:.85rem;"></p><div style="display:flex;gap:8px;flex-wrap:wrap;"><button class="btn" type="submit">Verify & switch</button><button class="btn" type="button" data-switch-cancel>Cancel</button></div>';
    panel.addEventListener("submit", async event => {
      event.preventDefault();
      const code = String(panel.elements.code.value || "").trim().toUpperCase();
      const password = panel.elements.password.value;
      const submit = panel.querySelector('button[type="submit"]');
      if (!code || !password) return;
      submit.disabled = true;
      panel.querySelector("[data-switch-message]").textContent = "Checking linked account…";
      const { data: allowed, error: verifyError } = await supabaseClient.rpc("pulse_is_linked_sibling_code", {
        p_student_code: code
      });
      if (verifyError || allowed !== true) {
        panel.querySelector("[data-switch-message]").textContent = "This account is not linked yet. Use Add a sibling first.";
        submit.disabled = false;
        return;
      }
      await NEXORAFinishSiblingAuthentication(code, password, panel.dataset.targetStudentId, null, panel);
    });
    panel.querySelector("[data-switch-cancel]").addEventListener("click", () => {
      panel.reset();
      panel.remove();
    });
    section.append(panel);
  }
  panel.dataset.targetStudentId = String(sibling.student_id);
  panel.querySelector("strong").textContent = "Switch to " + (sibling.student_name || "sibling");
  panel.elements.code.value = "";
  panel.elements.password.value = "";
  panel.querySelector("[data-switch-message]").textContent = "Enter this linked sibling's credentials to switch accounts.";
  panel.scrollIntoView({ behavior: "smooth", block: "center" });
  panel.elements.code.focus();
}

async function studentLogout() {
  // Stop this student's notifications on this device before signing out.
  const code = window.NEXORA_CURRENT_STUDENT?.student_code;
  if (code && window.NEXORAPush) await NEXORAPush.disable("student", code).catch(() => {});
  if (supabaseClient) await supabaseClient.auth.signOut();
  localStorage.removeItem("auraway_student_code");
  localStorage.removeItem("auraway_student_profile");
  NEXORAShowLogin("You have signed out.");
}

document.addEventListener("DOMContentLoaded", NEXORAInitializeStudentAuth, { once: true });
