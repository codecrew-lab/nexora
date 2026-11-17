package com.nexora.school

import android.os.Bundle

class TeacherPortalActivity : MainActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        portalName = "NEXORA-T"
        targetUrl = "file:///android_asset/teacher.html"
        super.onCreate(savedInstanceState)
    }
}
