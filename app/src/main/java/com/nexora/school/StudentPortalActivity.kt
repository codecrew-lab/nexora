package com.nexora.school

import android.os.Bundle

class StudentPortalActivity : MainActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        portalName = "NEXORA"
        targetUrl = "file:///android_asset/index.html"
        super.onCreate(savedInstanceState)
    }
}
