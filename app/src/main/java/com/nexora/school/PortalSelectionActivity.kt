package com.nexora.school

import android.content.Intent
import android.os.Bundle
import android.view.View
import androidx.appcompat.app.AppCompatActivity
import com.nexora.school.databinding.ActivityPortalSelectionBinding

class PortalSelectionActivity : AppCompatActivity() {

    private lateinit var binding: ActivityPortalSelectionBinding

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityPortalSelectionBinding.inflate(layoutInflater)
        setContentView(binding.root)

        playWelcomeAnimation()

        binding.btnContinuePortal.setOnClickListener {
            binding.btnContinuePortal.isEnabled = false
            binding.welcomeOverlay.animate()
                .alpha(0f)
                .setDuration(420L)
                .withEndAction {
                    binding.welcomeOverlay.visibility = View.GONE
                    binding.portalContent.visibility = View.VISIBLE
                    binding.portalContent.animate()
                        .alpha(1f)
                        .setDuration(420L)
                        .start()
                }
                .start()
        }

        // Portal 1: Student Portal (NEXORA)
        binding.btnOpenStudent.setOnClickListener {
            launchPortal(StudentPortalActivity::class.java)
        }
        binding.cardStudentPortal.setOnClickListener {
            launchPortal(StudentPortalActivity::class.java)
        }

        // Portal 2: Parent Portal (NEXORA-P)
        binding.btnOpenParent.setOnClickListener {
            launchPortal(ParentPortalActivity::class.java)
        }
        binding.cardParentPortal.setOnClickListener {
            launchPortal(ParentPortalActivity::class.java)
        }

        // Portal 3: Teacher Portal (NEXORA-T)
        binding.btnOpenTeacher.setOnClickListener {
            launchPortal(TeacherPortalActivity::class.java)
        }
        binding.cardTeacherPortal.setOnClickListener {
            launchPortal(TeacherPortalActivity::class.java)
        }
    }

    private fun playWelcomeAnimation() {
        binding.imgWelcomeLogo.animate()
            .alpha(1f)
            .scaleX(1f)
            .scaleY(1f)
            .setStartDelay(120L)
            .setDuration(850L)
            .start()

        binding.tvWelcomeName.animate()
            .alpha(1f)
            .translationY(0f)
            .setStartDelay(420L)
            .setDuration(650L)
            .start()

        binding.tvWelcomeTagline.animate()
            .alpha(1f)
            .translationY(0f)
            .setStartDelay(650L)
            .setDuration(650L)
            .start()

        binding.tvWelcomeCopy.animate()
            .alpha(1f)
            .translationY(0f)
            .setStartDelay(820L)
            .setDuration(650L)
            .start()

        binding.btnContinuePortal.animate()
            .alpha(1f)
            .translationY(0f)
            .setStartDelay(1050L)
            .setDuration(650L)
            .start()
    }

    private fun launchPortal(activityClass: Class<*>) {
        val intent = Intent(this, activityClass)
        startActivity(intent)
    }
}
