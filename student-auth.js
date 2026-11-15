// PULSE student authentication.
// Student identity is established by a Supabase Auth session, never by localStorage alone.
const PULSE_STUDENT_EMAIL_SUFFIX = "@students.pulse.app";

function pulseStudentEmail(code) {
  return String(code || "").trim().toLowerCase() + PULSE_STUDENT_EMAIL_SUFFIX;
}

function pulseShowLogin(message = "") {
  document.body.innerHTML = `
    <main style="min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg-primary,#0b0f19);color:var(--text-primary,#f9fafb);padding:20px;font-family:system-ui,sans-serif;">
      <section style="max-width:420px;width:100%;background:var(--bg-card,#1f2937);border:1px solid var(--border-color,#374151);border-radius:16px;padding:28px;">
        <h1 style="text-align:center;margin:0 0 8px;">PULSE 🎓</h1>
        <p style="color:var(--text-secondary,#9ca3af);text-align:center;margin:0 0 20px;">Sign in with the student code and password given by your teacher.</p>
        <form id="pulseStudentLoginForm" style="display:grid;gap:12px;">
          <label for="pulseStudentCode">Student code</label>
          <input id="pulseStudentCode" autocomplete="username" autocapitalize="characters" required placeholder="e.g. CLASS8-1234" style="width:100%;box-sizing:border-box;padding:12px;border-radius:8px;border:1px solid #475569;background:#0f172a;color:#fff;font-size:1rem;">
          <label for="pulseStudentPassword">Student password</label>
          <input id="pulseStudentPassword" type="password" autocomplete="current-password" required placeholder="Enter your password" style="width:100%;box-sizing:border-box;padding:12px;border-radius:8px;border:1px solid #475569;background:#0f172a;color:#fff;font-size:1rem;">
          <p id="pulseStudentAuthError" role="alert" style="color:#f87171;font-size:.9rem;margin:0;min-height:1.2em;">${message.replace(/[&<>"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch]))}</p>
          <button id="pulseStudentLoginButton" type="submit" style="width:100%;padding:12px;border:0;border-radius:8px;background:#6366f1;color:white;font-weight:700;font-size:1rem;cursor:pointer;">Sign in securely</button>
        </form>
        <p style="font-size:.78rem;color:var(--text-secondary,#9ca3af);text-align:center;margin:14px 0 0;">Forgot your password? Ask your teacher to reset your student login.</p>
      </section>
    </main>`;

  document.getElementById("pulseStudentLoginForm").addEventListener("submit", pulseStudentSignIn);
}

async function pulseStudentSignIn(event) {
  event.preventDefault();
  const codeInput = document.getElementById("pulseStudentCode");
  const passwordInput = document.getElementById("pulseStudentPassword");
  const errorBox = document.getElementById("pulseStudentAuthError");
  const button = document.getElementById("pulseStudentLoginButton");
  const code = codeInput.value.trim().toUpperCase();
  const password = passwordInput.value;
  if (!code || !password || !supabaseClient) {
    errorBox.textContent = "Enter your student code and password.";
    return;
  }

  button.disabled = true;
  button.textContent = "Signing in…";
  errorBox.textContent = "";
  const { data, error } = await supabaseClient.auth.signInWithPassword({
    email: pulseStudentEmail(code),
    password
  });

  if (error || !data?.user) {
    button.disabled = false;
    button.textContent = "Sign in securely";
    errorBox.textContent = "Sign-in failed. Check your code and password, or ask your teacher to reset them.";
    passwordInput.value = "";
    return;
  }

  const { data: profile, error: profileError } = await supabaseClient
    .from("students")
    .select("id,student_name,class_name,student_code,study_hours,attendance_pct,teacher_request,areas_to_improve")
    .eq("auth_user_id", data.user.id)
    .maybeSingle();

  if (profileError || !profile) {
    await supabaseClient.auth.signOut();
    button.disabled = false;
    button.textContent = "Sign in securely";
    errorBox.textContent = "This login is not linked to an active student record. Please contact your teacher.";
    return;
  }

  localStorage.setItem("auraway_student_code", profile.student_code);
  localStorage.setItem("auraway_student_profile", JSON.stringify(profile));
  window.location.reload();
}

async function pulseInitializeStudentAuth() {
  const currentPage = window.location.pathname.split("/").pop() || "index.html";
  if (["teacher.html", "parent.html", "portals.html"].includes(currentPage)) return;

  if (!supabaseClient) {
    pulseShowLogin("The secure login service is unavailable. Please try again later.");
    return;
  }

  const { data: sessionData, error: sessionError } = await supabaseClient.auth.getSession();
  const session = sessionData?.session;
  if (sessionError || !session) {
    localStorage.removeItem("auraway_student_code");
    localStorage.removeItem("auraway_student_profile");
    pulseShowLogin();
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
    pulseShowLogin("This account is not linked to a student record. Ask your teacher for help.");
    return;
  }

  localStorage.setItem("auraway_student_code", profile.student_code);
  localStorage.setItem("auraway_student_profile", JSON.stringify(profile));
  window.PULSE_CURRENT_STUDENT = profile;
  pulseAddStudentAccountControls();
  window.dispatchEvent(new CustomEvent("pulseStudentReady", { detail: { profile } }));
}

function pulseAddStudentAccountControls() {
  const header = document.querySelector(".header-bar");
  if (!header || document.getElementById("pulseStudentAccountControls")) return;
  const wrap = document.createElement("div");
  wrap.id = "pulseStudentAccountControls";
  wrap.style.cssText = "display:flex;align-items:center;gap:8px;flex-wrap:wrap;";
  const siblingsButton = document.createElement("button");
  siblingsButton.type = "button"; siblingsButton.className = "btn"; siblingsButton.textContent = "My Siblings";
  siblingsButton.addEventListener("click", () => document.getElementById("pulseSiblingAccounts")?.scrollIntoView({behavior:"smooth",block:"center"}));
  const signOutButton = document.createElement("button");
  signOutButton.type = "button"; signOutButton.className = "btn"; signOutButton.textContent = "Sign out";
  signOutButton.addEventListener("click", studentLogout);
  wrap.append(siblingsButton, signOutButton); header.appendChild(wrap);
}
function pulseOpenSiblingSwitch(sibling) {
  const section = document.getElementById("pulseSiblingAccounts");
  if (!section) return;
  let panel = section.querySelector("[data-sibling-switch]");
  if (!panel) {
    panel = document.createElement("form");
    panel.dataset.siblingSwitch = "true";
    panel.style.cssText = "display:grid;gap:10px;margin-top:14px;padding:14px;border:1px solid var(--border-color);border-radius:12px;";
    panel.innerHTML = '<strong></strong><label>Student code<input name="code" required autocomplete="username" style="display:block;width:100%;box-sizing:border-box;padding:10px;margin-top:5px;border-radius:8px;border:1px solid var(--border-color);background:var(--bg-primary);color:var(--text-primary);"></label><label>Password<input name="password" type="password" required autocomplete="current-password" style="display:block;width:100%;box-sizing:border-box;padding:10px;margin-top:5px;border-radius:8px;border:1px solid var(--border-color);background:var(--bg-primary);color:var(--text-primary);"></label><p data-switch-message role="status" style="margin:0;color:var(--text-secondary);font-size:.85rem;"></p><div style="display:flex;gap:8px;flex-wrap:wrap;"><button class="btn" type="submit">Verify & switch</button><button class="btn" type="button" data-switch-cancel>Cancel</button></div>';
    panel.addEventListener("submit", async event => {
      event.preventDefault();
      const targetId=Number(panel.dataset.targetStudentId),code=String(panel.elements.code.value||"").trim().toUpperCase(),password=panel.elements.password.value;
      const message=panel.querySelector("[data-switch-message]"),submit=panel.querySelector('button[type="submit"]');
      if(!code||!password)return; submit.disabled=true; message.textContent="Verifying linked account…";
      const {data:allowed,error:verifyError}=await supabaseClient.rpc("pulse_is_linked_sibling_code",{p_student_code:code});
      if(verifyError||allowed!==true){message.textContent="That code is not linked to your account. Ask your teacher to verify the link.";submit.disabled=false;return;}
      const {data:signedIn,error:signInError}=await supabaseClient.auth.signInWithPassword({email:pulseStudentEmail(code),password});
      if(signInError||!signedIn?.user){message.textContent="Sign-in failed. Check the sibling code and password.";panel.elements.password.value="";submit.disabled=false;return;}
      const {data:profile,error:profileError}=await supabaseClient.from("students").select("id,student_name,class_name,student_code,study_hours,attendance_pct,teacher_request,areas_to_improve").eq("auth_user_id",signedIn.user.id).maybeSingle();
      if(profileError||!profile||Number(profile.id)!==targetId){await supabaseClient.auth.signOut();localStorage.removeItem("auraway_student_code");localStorage.removeItem("auraway_student_profile");message.textContent="The account could not be verified. Please sign in again.";submit.disabled=false;return;}
      if(typeof pulseResetSessionDeadline==="function")pulseResetSessionDeadline();
      localStorage.setItem("auraway_student_code",profile.student_code);localStorage.setItem("auraway_student_profile",JSON.stringify(profile));window.location.reload();
    });
    panel.querySelector("[data-switch-cancel]").addEventListener("click",()=>{panel.reset();panel.remove();});
    section.append(panel);
  }
  panel.dataset.targetStudentId=String(sibling.student_id);
  panel.querySelector("strong").textContent="Switch to "+(sibling.student_name||"sibling");
  panel.elements.code.value="";panel.elements.password.value="";
  panel.querySelector("[data-switch-message]").textContent="Enter the credentials for this linked student account.";
  panel.scrollIntoView({behavior:"smooth",block:"center"});panel.elements.code.focus();
}

