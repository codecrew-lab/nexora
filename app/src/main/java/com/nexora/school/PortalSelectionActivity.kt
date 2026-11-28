package com.nexora.school

import android.animation.Animator
import android.animation.AnimatorSet
import android.animation.ObjectAnimator
import android.content.Intent
import android.os.Bundle
import android.view.View
import android.view.animation.DecelerateInterpolator
import androidx.appcompat.app.AppCompatActivity
import com.nexora.school.databinding.ActivityPortalSelectionBinding

class PortalSelectionActivity : AppCompatActivity() {

    private lateinit var binding: ActivityPortalSelectionBinding

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityPortalSelectionBinding.inflate(layoutInflater)
        setContentView(binding.root)

        // Start only after the first layout pass so the initial states are
        // applied before the welcome elements animate into view.
        binding.welcomeOverlay.post { playWelcomeAnimation() }

        binding.btnContinuePortal.setOnClickListener {
            binding.btnContinuePortal.isEnabled = false
            binding.welcomeOverlay.animate()
                .alpha(0f)
                .setDuration(420L)
                .withEndAction {
                    binding.welcomeOverlay.visibility = View.GONE
                    binding.portalContent.visibility = View.VISIBLE
                    binding.portalContent.alpha = 0f
                    binding.portalContent.animate()
                        .alpha(1f)
                        .setDuration(420L)
                        .start()
                }
                .start()
        }

        binding.btnOpenStudent.setOnClickListener {
            launchPortal(StudentPortalActivity::class.java)
        }
        binding.cardStudentPortal.setOnClickListener {
            launchPortal(StudentPortalActivity::class.java)
        }

        binding.btnOpenParent.setOnClickListener {
            launchPortal(ParentPortalActivity::class.java)
        }
        binding.cardParentPortal.setOnClickListener {
            launchPortal(ParentPortalActivity::class.java)
        }

        binding.btnOpenTeacher.setOnClickListener {
            launchPortal(TeacherPortalActivity::class.java)
        }
        binding.cardTeacherPortal.setOnClickListener {
            launchPortal(TeacherPortalActivity::class.java)
        }
    }

    private fun playWelcomeAnimation() {
        val views = listOf(
            binding.imgWelcomeLogo to 120L,
            binding.tvWelcomeName to 360L,
            binding.tvWelcomeTagline to 540L,
            binding.tvWelcomeCopy to 700L,
            binding.btnContinuePortal to 900L
        )

        // Explicitly reset every animated view. This also makes the entrance
        // animation reliable if Android recreates this Activity.
        views.forEach { (view, _) ->
            view.animate().cancel()
            view.alpha = 0f
            view.translationY = if (view == binding.imgWelcomeLogo) 18f else 14f
            if (view == binding.imgWelcomeLogo) {
                view.scaleX = 0.82f
                view.scaleY = 0.82f
            }
        }

        views.forEach { (view, delay) ->
            val animators = mutableListOf<Animator>(
                ObjectAnimator.ofFloat(view, View.ALPHA, 0f, 1f),
                ObjectAnimator.ofFloat(view, View.TRANSLATION_Y, view.translationY, 0f)
            )
            if (view == binding.imgWelcomeLogo) {
                animators += ObjectAnimator.ofFloat(view, View.SCALE_X, 0.82f, 1f)
                animators += ObjectAnimator.ofFloat(view, View.SCALE_Y, 0.82f, 1f)
            }

            AnimatorSet().apply {
                playTogether(animators)
                startDelay = delay
                duration = 620L
                interpolator = DecelerateInterpolator()
                start()
            }
        }
    }

    private fun launchPortal(activityClass: Class<*>) {
        startActivity(Intent(this, activityClass))
    }
}
