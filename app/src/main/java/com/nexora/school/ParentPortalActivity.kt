package com.nexora.school

import android.os.Bundle

class ParentPortalActivity : MainActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        portalName = "NEXORA-P"
        targetUrl = "file:///android_asset/parent.html"
        super.onCreate(savedInstanceState)
    }
}
