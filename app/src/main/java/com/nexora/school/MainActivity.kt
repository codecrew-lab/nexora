package com.nexora.school

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import com.nexora.school.databinding.ActivityMainBinding

open class MainActivity : AppCompatActivity() {

    protected lateinit var binding: ActivityMainBinding
    protected open var portalName: String = "NEXORA"
    protected open var targetUrl: String = "file:///android_asset/index.html"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        // Portal activities choose their own bundled asset. Never accept a URL
        // supplied by an external Intent.
        if (!isTrustedAssetUrl(targetUrl)) {
            targetUrl = "file:///android_asset/index.html"
        }

        binding.tvHeaderTitle.text = portalName

        setupWebView()
        setupListeners()
        setupBackPressed()

        binding.webView.loadUrl(targetUrl)
    }

    private fun isTrustedAssetUrl(value: String): Boolean {
        return runCatching {
            val uri = Uri.parse(value)
            val path = uri.path.orEmpty()
            uri.scheme == "file" &&
                uri.authority.isNullOrEmpty() &&
                path.startsWith("/android_asset/") &&
                path.split('/').none { it == ".." }
        }.getOrDefault(false)
    }

    private fun openExternalHttps(value: String) {
        val uri = runCatching { Uri.parse(value) }.getOrNull() ?: return
        if (uri.scheme != "https" || uri.host.isNullOrBlank()) return

        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri))
        } catch (_: ActivityNotFoundException) {
            // Leave the current trusted portal open if no browser can handle it.
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        val settings: WebSettings = binding.webView.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.allowFileAccess = true
        settings.allowContentAccess = false
        settings.allowFileAccessFromFileURLs = false
        settings.allowUniversalAccessFromFileURLs = false
        settings.databaseEnabled = true
        settings.useWideViewPort = true
        settings.loadWithOverviewMode = true
        settings.cacheMode = WebSettings.LOAD_DEFAULT
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
            settings.safeBrowsingEnabled = true
        }

        binding.webView.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                super.onPageStarted(view, url, favicon)
                binding.progressBar.visibility = View.VISIBLE
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                binding.progressBar.visibility = View.GONE
                binding.swipeRefresh.isRefreshing = false
            }

            override fun shouldOverrideUrlLoading(view: WebView?, request: android.webkit.WebResourceRequest?): Boolean {
                val url = request?.url?.toString() ?: return true
                if (isTrustedAssetUrl(url)) return false
                if (Uri.parse(url).scheme == "https") openExternalHttps(url)
                return true
            }

            @Suppress("DEPRECATION")
            override fun shouldOverrideUrlLoading(view: WebView?, url: String?): Boolean {
                val value = url ?: return true
                if (isTrustedAssetUrl(value)) return false
                if (Uri.parse(value).scheme == "https") openExternalHttps(value)
                return true
            }
        }

        binding.webView.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                if (newProgress < 100) {
                    binding.progressBar.visibility = View.VISIBLE
                    binding.progressBar.progress = newProgress
                } else {
                    binding.progressBar.visibility = View.GONE
                }
            }
        }
    }

    private fun setupListeners() {
        binding.swipeRefresh.setOnRefreshListener {
            binding.webView.reload()
        }

        binding.btnRefresh.setOnClickListener {
            binding.webView.reload()
        }

        binding.btnSwitchPortal.setOnClickListener {
            val intent = Intent(this, PortalSelectionActivity::class.java)
            startActivity(intent)
        }
    }

    private fun setupBackPressed() {
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (binding.webView.canGoBack()) {
                    binding.webView.goBack()
                } else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            }
        })
    }
}
